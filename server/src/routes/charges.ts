import type { FastifyInstance } from 'fastify';
import { normalizeUid } from '../uid.js';
import { cardJson, findCardByUid, type CardRow } from './cards.js';

interface TxRow {
  id: number; card_id: string; amount: number; type: 'give' | 'storno'; status: 'ok' | 'stornoed';
  ref: number | null; terminal_id: string | null; operator_id: string | null;
  idempotency_key: string | null; created_at: string; balance_after: number;
}

class Refusal extends Error {
  constructor(public status: number, public code: string, message: string, public extra: object = {}) { super(message); }
}

export function registerCharges(app: FastifyInstance) {
  const db = app.db;
  const terminalName = (id: string | null) => id ? (db.prepare('select name from terminals where id=?').get(id) as { name: string } | undefined)?.name ?? '' : '';
  const txJson = (t: TxRow) => ({ id: t.id, amount: t.amount, createdAt: t.created_at, terminal: terminalName(t.terminal_id) });
  const cardInfo = (c: CardRow, balanceBefore: number) => ({ id: c.id, name: c.name, photoUrl: cardJson(c).photoUrl, balanceBefore, balance: c.balance });

  const charge = db.transaction((terminalId: string, operatorId: string | null, uid: string, amount: number, key: string) => {
    const prior = db.prepare('select * from transactions where terminal_id=? and idempotency_key=?').get(terminalId, key) as TxRow | undefined;
    if (prior) {
      const card = db.prepare('select * from cards where id=?').get(prior.card_id) as CardRow;
      if (card.uid !== uid || prior.amount !== amount) throw new Refusal(409, 'key_reused', 'That idempotency key was used for a different charge');
      return { tx: prior, card, before: prior.balance_after - prior.amount };
    }
    const card = findCardByUid(db, uid);
    if (!card) throw new Refusal(404, 'unknown_card', 'Card not registered');
    if (card.status === 'blocked') throw new Refusal(403, 'card_blocked', 'Card is blocked', { card: { name: card.name, photoUrl: cardJson(card).photoUrl } });
    const now = new Date().toISOString();
    db.prepare('update cards set balance=balance+?, last_used=? where id=?').run(amount, now, card.id);
    const after = card.balance + amount;
    const id = db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,operator_id,idempotency_key,created_at,balance_after)
      values(?,?,'give','ok',?,?,?,?,?)`).run(card.id, amount, terminalId, operatorId, key, now, after).lastInsertRowid;
    return { tx: db.prepare('select * from transactions where id=?').get(id) as TxRow, card: { ...card, balance: after, last_used: now } as CardRow, before: card.balance };
  });

  const storno = db.transaction((id: number, user: { id: string; role: string; terminalId?: string; viaTerminal?: boolean }) => {
    const orig = db.prepare('select * from transactions where id=?').get(id) as TxRow | undefined;
    if (!orig) throw new Refusal(404, 'not_found', 'Transaction not found');
    if (user.role === 'operator' && orig.terminal_id !== user.terminalId) throw new Refusal(403, 'other_terminal', 'That charge was made on another terminal');
    if (orig.type !== 'give') throw new Refusal(400, 'not_a_charge', 'Only charges can be stornoed');
    if (orig.status === 'stornoed') throw new Refusal(400, 'already_stornoed', 'Already stornoed.');
    const card = db.prepare('select * from cards where id=?').get(orig.card_id) as CardRow;
    if (card.balance < orig.amount) throw new Refusal(400, 'would_go_negative', 'Card has fewer points than this storno.');
    const after = card.balance - orig.amount;
    db.prepare('update cards set balance=? where id=?').run(after, card.id);
    db.prepare("update transactions set status='stornoed' where id=?").run(id);
    const rid = db.prepare(`insert into transactions(card_id,amount,type,status,ref,terminal_id,operator_id,created_at,balance_after)
      values(?,?,'storno','ok',?,?,?,?,?)`).run(card.id, -orig.amount, id, user.terminalId ?? orig.terminal_id, user.viaTerminal ? null : user.id, new Date().toISOString(), after).lastInsertRowid;
    return { tx: db.prepare('select * from transactions where id=?').get(rid) as TxRow, card: { ...card, balance: after } as CardRow };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
    reply.send(err);
  });

  app.post('/charges', { preHandler: app.requireOperator }, async (req, reply) => {
    const b = (req.body ?? {}) as { cardUid?: string; amount?: unknown; idempotencyKey?: string };
    if (typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount < 1 || b.amount > 9999) {
      return reply.code(400).send({ error: 'Amount must be a whole number from 1 to 9999', code: 'bad_amount' });
    }
    if (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 100) {
      return reply.code(400).send({ error: 'idempotencyKey is required', code: 'bad_request' });
    }
    const uid = normalizeUid(b.cardUid ?? '');
    if (!uid) return reply.code(404).send({ error: 'Card not registered', code: 'unknown_card' });
    const r = charge(req.user.terminalId!, req.user.viaTerminal ? null : req.user.id, uid, b.amount, b.idempotencyKey);
    return { transaction: txJson(r.tx), card: cardInfo(r.card, r.before) };
  });

  app.get('/transactions', { preHandler: app.requireStaff }, async req => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const own = req.user.role === 'operator';
    const rows = db.prepare(`select t.*, c.name card_name, s.name operator_name from transactions t
      join cards c on c.id=t.card_id left join staff s on s.id=t.operator_id
      ${own ? 'where t.terminal_id=?' : ''} order by t.id desc limit ?`).all(...(own ? [req.user.terminalId] : []), limit) as (TxRow & { card_name: string; operator_name: string | null })[];
    return rows.map(t => ({
      id: t.id, type: t.type, amount: t.amount, status: t.status, ref: t.ref, createdAt: t.created_at,
      terminal: terminalName(t.terminal_id), operator: t.operator_name ?? terminalName(t.terminal_id),
      card: { id: t.card_id, name: t.card_name, photoUrl: `/cards/${t.card_id}/photo` },
    }));
  });

  app.post('/transactions/:id/storno', { preHandler: app.requireStaff }, async req => {
    const r = storno(Number((req.params as { id: string }).id), req.user);
    return { transaction: txJson(r.tx), card: cardInfo(r.card, r.card.balance + -r.tx.amount) };
  });
}
