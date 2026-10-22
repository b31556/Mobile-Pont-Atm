import type { FastifyInstance } from 'fastify';
import { normalizeUid } from '../uid.js';
import { findCardByUid } from './cards.js';

/** Unregistered cards that an operator tapped and asked an admin to add. */
export function registerSuggestions(app: FastifyInstance) {
  const db = app.db;

  app.post('/card-suggestions', { preHandler: app.requireOperator }, async (req, reply) => {
    const uid = normalizeUid(String((req.body as { cardUid?: string } | undefined)?.cardUid ?? ''));
    if (!uid) return reply.code(400).send({ error: 'That is not a valid card UID', code: 'bad_uid' });
    if (findCardByUid(db, uid)) return reply.code(409).send({ error: 'That card is already registered.', code: 'already_registered' });
    const now = new Date().toISOString();
    db.prepare(`insert into card_suggestions(uid,terminal_id,first_seen,last_seen,count) values(?,?,?,?,1)
      on conflict(uid) do update set terminal_id=excluded.terminal_id, last_seen=excluded.last_seen, count=count+1`)
      .run(uid, req.user.terminalId, now, now);
    return { ok: true };
  });

  app.get('/card-suggestions', { preHandler: app.requireAdmin }, async () => {
    const rows = db.prepare(`select s.uid, s.first_seen, s.last_seen, s.count, t.name terminal
      from card_suggestions s left join terminals t on t.id=s.terminal_id order by s.last_seen desc`).all() as
      { uid: string; first_seen: string; last_seen: string; count: number; terminal: string | null }[];
    return rows.map(r => ({ uid: r.uid, terminal: r.terminal ?? '', firstSeen: r.first_seen, lastSeen: r.last_seen, count: r.count }));
  });

  app.delete('/card-suggestions/:uid', { preHandler: app.requireAdmin }, async (req, reply) => {
    const uid = normalizeUid((req.params as { uid: string }).uid);
    const r = uid ? db.prepare('delete from card_suggestions where uid=?').run(uid) : { changes: 0 };
    if (!r.changes) return reply.code(404).send({ error: 'Suggestion not found' });
    return { ok: true };
  });
}
