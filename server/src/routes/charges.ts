import type { FastifyInstance } from 'fastify';
import { stamp } from '../clock.js';
import { normalizeUid } from '../uid.js';
import { cardJson, findCardByUid, type CardRow } from './cards.js';
import { publishCancelled, publishTap } from './display.js';
import { Refusal, stornoTransaction, type TxRow } from '../storno.js';

const HOUR_MS = 3600 * 1000;

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
      return { tx: prior, card, before: prior.balance_after - prior.amount, replayed: true };
    }
    const card = findCardByUid(db, uid);
    if (!card) throw new Refusal(404, 'unknown_card', 'Card not registered');
    if (card.status === 'blocked') throw new Refusal(403, 'card_blocked', 'Card is blocked', { card: { name: card.name, photoUrl: cardJson(card).photoUrl } });
    // A phone's token is enough to charge, so what one phone can give away per hour is capped (null = no limit).
    const limit = (db.prepare('select charge_limit_hour l from terminals where id=?').get(terminalId) as { l: number | null } | undefined)?.l ?? null;
    if (limit !== null) {
      const since = new Date(Date.now() - HOUR_MS).toISOString();
      const given = db.prepare("select coalesce(sum(amount),0) s, min(created_at) oldest from transactions where terminal_id=? and kind='atm' and type='give' and status='ok' and created_at>=?")
        .get(terminalId, since) as { s: number; oldest: string | null };
      if (given.s + amount > limit) {
        const retryInSeconds = given.oldest ? Math.max(1, Math.ceil((Date.parse(given.oldest) + HOUR_MS - Date.now()) / 1000)) : null;
        throw new Refusal(429, 'terminal_limit', `This phone has reached its limit of ${limit} points per hour. Ask an admin.`, { retryInSeconds });
      }
    }
    const now = stamp().toISOString();
    db.prepare('update cards set balance=balance+?, last_used=? where id=?').run(amount, now, card.id);
    const after = card.balance + amount;
    const id = db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,operator_id,idempotency_key,created_at,balance_after)
      values(?,?,'give','ok',?,?,?,?,?)`).run(card.id, amount, terminalId, operatorId, key, now, after).lastInsertRowid;
    return { tx: db.prepare('select * from transactions where id=?').get(id) as TxRow, card: { ...card, balance: after, last_used: now } as CardRow, before: card.balance, replayed: false };
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
    const answer = { transaction: txJson(r.tx), card: cardInfo(r.card, r.before) };
    if (!r.replayed) publishTap(app, req.user.terminalId, 'atm', { status: 200, body: answer });
    return answer;
  });

  app.get('/transactions', { preHandler: app.requireStaff }, async req => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const own = req.user.role === 'operator';
    const rows = db.prepare(`select t.*, c.name card_name, s.name operator_name, z.name zone_name from transactions t
      join cards c on c.id=t.card_id left join staff s on s.id=t.operator_id left join zones z on z.id=t.zone_id
      ${own ? 'where t.terminal_id=?' : ''} order by t.id desc limit ?`).all(...(own ? [req.user.terminalId] : []), limit) as (TxRow & { card_name: string; operator_name: string | null; zone_name: string | null })[];
    const list = rows.map(t => ({
      id: t.id as number | string, type: t.type as string, amount: t.amount, status: t.status as string, ref: t.ref, createdAt: t.created_at,
      kind: (t as { kind?: string }).kind ?? 'atm', note: (t as { note?: string | null }).note ?? null, zone: t.zone_name as string | null,
      terminal: terminalName(t.terminal_id), operator: t.operator_name ?? terminalName(t.terminal_id),
      card: { id: t.card_id, name: t.card_name, photoUrl: `/cards/${t.card_id}/photo` },
    }));
    if (own) return list;
    // Admins also see the points other admins granted or took away by hand.
    const adjustments = db.prepare(`select a.*, c.name card_name, s.name staff_name from balance_adjustments a
      join cards c on c.id=a.card_id left join staff s on s.id=a.staff_id order by a.created_at desc limit ?`).all(limit) as
      { id: string; card_id: string; delta: number; created_at: string; reason: string | null; card_name: string; staff_name: string | null }[];
    for (const a of adjustments) {
      list.push({
        id: a.id, type: 'adjust', amount: a.delta, status: 'ok', ref: null, createdAt: a.created_at, kind: 'adjust', note: a.reason, zone: null,
        terminal: '', operator: a.staff_name ?? '', card: { id: a.card_id, name: a.card_name, photoUrl: `/cards/${a.card_id}/photo` },
      });
    }
    return list.sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0)).slice(0, limit);
  });

  app.post('/transactions/:id/storno', { preHandler: app.requireStaff }, async req => {
    const r = stornoTransaction(db, Number((req.params as { id: string }).id), req.user);
    if (req.user.terminalId) publishCancelled(app, req.user.terminalId, r.card, `The charge was cancelled: ${Math.abs(r.tx.amount)} points taken back.`);   // the screen next to the reader says so too
    return { transaction: txJson(r.tx), card: cardInfo(r.card, r.card.balance + -r.tx.amount) };
  });
}
