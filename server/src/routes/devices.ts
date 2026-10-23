import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AttemptLimiter, TOO_MANY } from '../limiter.js';
import { defaultZone } from '../presence.js';

const ID_RE = /^[A-Za-z0-9:_-]{6,40}$/;
const MAX_WAITING = 20;
const WAITING_EXPIRES_MS = 15 * 60 * 1000;   // a waiting device that has gone quiet this long is forgotten
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface DeviceRow {
  id: string; secret_hash: string; status: 'pending' | 'approved' | 'revoked'; terminal_id: string | null;
  ip: string | null; firmware: string | null; first_seen: string; last_seen: string; pair_code: string | null;
  denied_count: number; denied_ip: string | null; denied_at: string | null;
}

/** Readers (ESP32) register themselves and wait for an admin to approve them; after that they act as a terminal. */
export function registerDevices(app: FastifyInstance) {
  const db = app.db;
  const calls = new AttemptLimiter(120, 5 * 60 * 1000);       // every hello counts, per address
  const badSecrets = new AttemptLimiter(10, 15 * 60 * 1000);  // wrong secrets, per address

  /** Waiting devices that stopped asking (switched off, or made up by someone) must not hold one of the 20 places forever. */
  function dropQuietWaiting() {
    db.prepare("delete from devices where status='pending' and last_seen < ?").run(new Date(Date.now() - WAITING_EXPIRES_MS).toISOString());
  }

  /** A 4-digit code no other waiting device has. The reader shows it and the admin sees it, so they can tell which reader is which. */
  function newPairCode(): string {
    const taken = new Set((db.prepare("select pair_code from devices where status='pending' and pair_code is not null").all() as { pair_code: string }[]).map(r => r.pair_code));
    for (;;) {
      const code = String(randomInt(1000, 10000));
      if (!taken.has(code)) return code;
    }
  }

  app.post('/device/hello', async (req, reply) => {
    const ip = req.ip;
    if (calls.blocked(ip) || badSecrets.blocked(ip)) return reply.code(429).send(TOO_MANY);
    calls.fail(ip);
    const b = (req.body ?? {}) as { deviceId?: unknown; secret?: unknown; firmware?: unknown };
    if (typeof b.deviceId !== 'string' || !ID_RE.test(b.deviceId)) return reply.code(400).send({ error: 'deviceId must be 6 to 40 letters, digits, colons, dashes or underscores' });
    if (typeof b.secret !== 'string' || b.secret.length < 16 || b.secret.length > 128) return reply.code(400).send({ error: 'secret must be 16 to 128 characters' });
    if (b.firmware !== undefined && (typeof b.firmware !== 'string' || b.firmware.length > 40)) return reply.code(400).send({ error: 'firmware must be text of up to 40 characters' });
    const firmware = (b.firmware as string | undefined) ?? null;
    const hash = sha256(b.secret);
    const now = new Date().toISOString();

    dropQuietWaiting();
    const row = db.prepare('select * from devices where id=?').get(b.deviceId) as DeviceRow | undefined;
    if (!row) {
      const waiting = (db.prepare("select count(*) c from devices where status='pending'").get() as { c: number }).c;
      if (waiting >= MAX_WAITING) return reply.code(429).send({ error: 'Too many devices are waiting for approval. Approve or remove some in admin.' });
      const code = newPairCode();
      db.prepare("insert into devices(id,secret_hash,status,ip,firmware,first_seen,last_seen,pair_code) values(?,?,'pending',?,?,?,?,?)").run(b.deviceId, hash, ip, firmware, now, now, code);
      return { status: 'pending', code };
    }
    if (!timingSafeEqual(Buffer.from(hash), Buffer.from(row.secret_hash))) {
      badSecrets.fail(ip);
      db.prepare('update devices set denied_count=denied_count+1, denied_ip=?, denied_at=? where id=?').run(ip, now, row.id);
      return reply.code(403).send({ error: 'Wrong secret for this device' });
    }
    db.prepare('update devices set ip=?, firmware=?, last_seen=? where id=?').run(ip, firmware ?? row.firmware, now, row.id);
    if (row.status === 'pending') {
      const code = row.pair_code ?? newPairCode();
      if (!row.pair_code) db.prepare('update devices set pair_code=? where id=?').run(code, row.id);
      return { status: 'pending', code };
    }
    if (row.status === 'revoked') return { status: 'revoked' };
    const t = db.prepare('select id,name,mode,active from terminals where id=?').get(row.terminal_id ?? '') as { id: string; name: string; mode: string; active: number } | undefined;
    if (!t || !t.active) {
      db.prepare("update devices set status='revoked' where id=?").run(row.id);
      if (row.terminal_id) app.displayHub.closeStreams(row.terminal_id);
      return { status: 'revoked' };
    }
    db.prepare('update terminals set last_seen=? where id=?').run(now, t.id);
    return { status: 'approved', terminalToken: app.jwt.sign({ kind: 'terminal', terminalId: t.id }), name: t.name, mode: t.mode };
  });

  app.get('/devices', { preHandler: app.requireAdmin }, async () => {
    dropQuietWaiting();
    const rows = db.prepare('select * from devices order by first_seen').all() as DeviceRow[];
    return rows.map(d => {
      const t = d.terminal_id ? db.prepare('select id,name,mode,active from terminals where id=?').get(d.terminal_id) as { id: string; name: string; mode: string; active: number } | undefined : undefined;
      return {
        id: d.id, status: d.status, code: d.status === 'pending' ? d.pair_code : null, ip: d.ip, firmware: d.firmware, firstSeen: d.first_seen, lastSeen: d.last_seen,
        online: Date.now() - Date.parse(d.last_seen) < ONLINE_WINDOW_MS,
        denied: d.denied_count > 0 ? { count: d.denied_count, ip: d.denied_ip, at: d.denied_at } : null,
        terminal: t && t.active ? { id: t.id, name: t.name, mode: t.mode } : null,
      };
    });
  });

  app.post('/devices/:id/approve', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; place?: string; mode?: string };
    const row = db.prepare('select * from devices where id=?').get(id) as DeviceRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Device not found' });
    if (row.status === 'approved') return reply.code(409).send({ error: 'This device is already approved.' });
    if (row.status === 'revoked') return reply.code(409).send({ error: 'This device was revoked. Forget it first, then it can register again.' });
    if (b.name !== undefined && typeof b.name !== 'string') return reply.code(400).send({ error: 'The name must be text' });
    if (b.place !== undefined && typeof b.place !== 'string') return reply.code(400).send({ error: 'The place must be text' });
    const name = (b.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Give the reader a name' });
    const mode = b.mode ?? 'fixed';
    if (!['fixed', 'presence'].includes(mode)) return reply.code(400).send({ error: 'mode must be fixed or presence' });
    const terminalId = randomUUID();
    db.transaction(() => {
      db.prepare("insert into terminals(id,name,place,active,mode,kind,zone_id) values(?,?,?,1,?,'device',?)")
        .run(terminalId, name, b.place ?? '', mode, mode === 'presence' ? defaultZone(db).id : null);
      db.prepare("update devices set status='approved', terminal_id=?, pair_code=NULL where id=?").run(terminalId, id);
    })();
    return { device: { id, status: 'approved' }, terminal: { id: terminalId, name, mode } };
  });

  app.delete('/devices/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('select * from devices where id=?').get(id) as DeviceRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Device not found' });
    if (row.status === 'approved') {
      db.transaction(() => {
        if (row.terminal_id) db.prepare('update terminals set active=0 where id=?').run(row.terminal_id);
        db.prepare("update devices set status='revoked' where id=?").run(id);
      })();
      if (row.terminal_id) app.displayHub.closeStreams(row.terminal_id);
    } else {
      db.prepare('delete from devices where id=?').run(id);   // a waiting one is rejected, a revoked one forgotten
    }
    return { ok: true };
  });
}
