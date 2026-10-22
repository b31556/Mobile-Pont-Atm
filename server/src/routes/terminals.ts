import { randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { checkTerminalToken } from '../auth.js';
import { TOO_MANY } from '../limiter.js';

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
        givenToday: given.s, operator: t.last_operator ?? '', mode: t.mode,
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
    const b = (req.body ?? {}) as { name?: string; place?: string; mode?: string };
    if (!db.prepare('select 1 from terminals where id=? and active=1').get(id)) return reply.code(404).send({ error: 'Terminal not found' });
    if (b.mode !== undefined && !['atm', 'presence'].includes(b.mode)) return reply.code(400).send({ error: 'mode must be atm or presence' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'Give the terminal a name' });
    const set: string[] = []; const vals: unknown[] = [];
    if (b.name !== undefined) { set.push('name=?'); vals.push(b.name.trim()); }
    if (b.place !== undefined) { set.push('place=?'); vals.push(b.place); }
    if (b.mode !== undefined) { set.push('mode=?'); vals.push(b.mode); }
    if (set.length) db.prepare(`update terminals set ${set.join(',')} where id=?`).run(...vals, id);
    return db.prepare('select id,name,place,mode from terminals where id=?').get(id);
  });

  app.delete('/terminals/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('update terminals set active=0 where id=?').run(id);
    if (!r.changes) return reply.code(404).send({ error: 'Terminal not found' });
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
