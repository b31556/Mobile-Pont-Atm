import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { checkTerminalToken } from '../auth.js';
import { TOO_MANY } from '../limiter.js';
import { defaultZone, getZone } from '../presence.js';
import { validateFixed } from '../fixed.js';
import { fixedOf } from './fixed.js';
import { displayCodeFor, renewDisplayCode } from './display.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export function registerTerminals(app: FastifyInstance) {
  const db = app.db;

  function newCode(terminalId: string): string {
    db.prepare('delete from pairing_codes where terminal_id=? or expires_at < ?').run(terminalId, Date.now());
    for (;;) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (db.prepare('select 1 from pairing_codes where code=?').get(code)) continue;
      db.prepare('insert into pairing_codes(code,terminal_id,expires_at,used) values(?,?,?,0)').run(code, terminalId, Date.now() + CODE_TTL_MS);
      return code;
    }
  }

  app.get('/terminals', { preHandler: app.requireAdmin }, async () => {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const rows = db.prepare('select * from terminals where active=1 order by name').all() as any[];
    return rows.map(t => {
      const given = db.prepare("select coalesce(sum(amount),0) s from transactions where terminal_id=? and type='give' and status='ok' and created_at>=?")
        .get(t.id, midnight.toISOString()) as { s: number };
      return {
        id: t.id, name: t.name, place: t.place, lastSeen: t.last_seen, appVersion: t.app_version, device: t.device,
        online: !!t.last_seen && Date.now() - Date.parse(t.last_seen) < ONLINE_WINDOW_MS,
        givenToday: given.s, operator: t.last_operator ?? '', mode: t.mode, direction: t.direction, kind: t.kind, fixed: fixedOf(t), displayCode: displayCodeFor(db, t.id), displayBeep: !!t.display_beep,
        ip: t.kind === 'device' ? (db.prepare('select ip from devices where terminal_id=?').get(t.id) as { ip: string | null } | undefined)?.ip ?? null : null,
        firmware: t.kind === 'device' ? (db.prepare('select firmware from devices where terminal_id=?').get(t.id) as { firmware: string | null } | undefined)?.firmware ?? null : null,
        zoneId: t.zone_id ?? null, zoneName: t.zone_id ? (db.prepare('select name from zones where id=?').get(t.zone_id) as { name: string } | undefined)?.name ?? null : null,
      };
    });
  });

  app.post('/terminals', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; place?: string };
    if (!b.name?.trim()) return reply.code(400).send({ error: 'Give the terminal a name' });
    const id = randomUUID();
    db.prepare('insert into terminals(id,name,place,active) values(?,?,?,1)').run(id, b.name.trim(), b.place ?? '');
    return reply.code(201).send({ terminal: { id, name: b.name.trim(), place: b.place ?? '' }, pairingCode: newCode(id) });
  });

  app.post('/terminals/:id/pairing-code', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.prepare('select 1 from terminals where id=? and active=1').get(id)) return reply.code(404).send({ error: 'Terminal not found' });
    return { pairingCode: newCode(id) };
  });

  app.patch('/terminals/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; place?: string; mode?: string; zoneId?: string; direction?: string; fixed?: unknown; displayBeep?: unknown };
    const t = db.prepare('select zone_id, kind from terminals where id=? and active=1').get(id) as { zone_id: string | null; kind: string } | undefined;
    if (!t) return reply.code(404).send({ error: 'Terminal not found' });
    if (b.mode !== undefined) {
      const allowed = t.kind === 'device' ? ['presence', 'fixed'] : ['atm', 'presence'];
      if (!allowed.includes(b.mode)) return reply.code(400).send({ error: t.kind === 'device' ? 'A reader can be in check-in (presence) or fixed-amount mode' : 'A phone can be in ATM or check-in (presence) mode' });
    }
    if (b.displayBeep !== undefined && typeof b.displayBeep !== 'boolean') return reply.code(400).send({ error: 'displayBeep must be true or false' });
    let fixed = null;
    if (b.fixed !== undefined) {
      if (t.kind !== 'device') return reply.code(400).send({ error: 'Only readers have fixed-amount settings' });
      const v = validateFixed(b.fixed);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      fixed = v.value;
    }
    if (b.direction !== undefined && !['in', 'out', 'toggle'].includes(b.direction)) return reply.code(400).send({ error: 'direction must be in, out or toggle' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'Give the terminal a name' });
    if (b.zoneId !== undefined && !getZone(db, b.zoneId)) return reply.code(404).send({ error: 'Zone not found' });
    const set: string[] = []; const vals: unknown[] = [];
    if (b.name !== undefined) { set.push('name=?'); vals.push(b.name.trim()); }
    if (b.place !== undefined) { set.push('place=?'); vals.push(b.place); }
    if (b.mode !== undefined) { set.push('mode=?'); vals.push(b.mode); }
    if (b.direction !== undefined) { set.push('direction=?'); vals.push(b.direction); }
    if (fixed) {
      set.push('fixed_amount=?', 'fixed_cooldown_seconds=?', 'fixed_max_uses_24h=?', 'fixed_max_points_24h=?', 'fixed_max_uses_total=?');
      vals.push(fixed.amount, fixed.cooldownSeconds, fixed.maxUses24h, fixed.maxPoints24h, fixed.maxUsesTotal);
    }
    if (b.displayBeep !== undefined) { set.push('display_beep=?'); vals.push(b.displayBeep ? 1 : 0); }
    if (b.zoneId !== undefined) { set.push('zone_id=?'); vals.push(b.zoneId); }
    else if (b.mode === 'presence' && !t.zone_id) { set.push('zone_id=?'); vals.push(defaultZone(db).id); }
    if (set.length) db.prepare(`update terminals set ${set.join(',')} where id=?`).run(...vals, id);
    return db.prepare('select id,name,place,mode,zone_id zoneId,direction from terminals where id=?').get(id);
  });

  /** Makes a new display code, signs out every screen that used the old one, and hangs up their live connections. */
  app.post('/terminals/:id/display-code', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.prepare('select 1 from terminals where id=? and active=1').get(id)) return reply.code(404).send({ error: 'Terminal not found' });
    const displayCode = renewDisplayCode(db, id);
    app.displayHub.closeStreams(id);
    return { displayCode };
  });

  app.delete('/terminals/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('update terminals set active=0 where id=?').run(id);
    if (!r.changes) return reply.code(404).send({ error: 'Terminal not found' });
    db.prepare("update devices set status='revoked' where terminal_id=? and status='approved'").run(id);
    app.displayHub.closeStreams(id);   // a reader is cut off in the list at once
    db.prepare('delete from pairing_codes where terminal_id=?').run(id);
    return { ok: true };
  });

  app.post('/pair', async (req, reply) => {
    const b = (req.body ?? {}) as { code?: string; device?: string; appVersion?: string };
    if (app.pairLimiter.blocked(req.ip)) return reply.code(429).send(TOO_MANY);
    const row = db.prepare('select * from pairing_codes where code=?').get(String(b.code ?? '').replace(/\s/g, '')) as
      { code: string; terminal_id: string; expires_at: number; used: number } | undefined;
    if (!row || row.used || row.expires_at < Date.now()) { app.pairLimiter.fail(req.ip); return reply.code(400).send({ error: 'Code already used or expired' }); }
    const t = db.prepare('select id,name from terminals where id=? and active=1').get(row.terminal_id) as { id: string; name: string } | undefined;
    if (!t) return reply.code(400).send({ error: 'Code already used or expired' });
    app.pairLimiter.clear(req.ip);
    db.prepare('update pairing_codes set used=1 where code=?').run(row.code);
    db.prepare('update terminals set device=?, app_version=?, last_seen=? where id=?').run(b.device ?? '', b.appVersion ?? '', new Date().toISOString(), t.id);
    return { terminalToken: app.jwt.sign({ kind: 'terminal', terminalId: t.id }), terminal: { id: t.id, name: t.name } };
  });

  app.post('/heartbeat', async (req, reply) => {
    const raw = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    let terminalId: string | undefined;
    const asTerminal = checkTerminalToken(app, raw);
    if ('terminalId' in asTerminal) terminalId = asTerminal.terminalId;
    else {
      await app.requireOperator(req, reply);
      if (reply.sent) return;
      terminalId = req.user.terminalId;
    }
    db.prepare('update terminals set last_seen=? where id=?').run(new Date().toISOString(), terminalId);
    return { ok: true };
  });
}
