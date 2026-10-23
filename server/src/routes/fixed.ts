import type { FastifyInstance } from 'fastify';
import { stamp } from '../clock.js';
import { evaluateFixed, type FixedSettings, type FixedStats } from '../fixed.js';
import { normalizeUid } from '../uid.js';
import { findCardByUid, type CardRow } from './cards.js';
import { recordSuggestion } from './suggestions.js';

type Reply = { status: number; body: object };
const DAY_MS = 24 * 3600 * 1000;

export function fixedOf(t: Record<string, unknown>): FixedSettings {
  return {
    amount: t.fixed_amount as number, cooldownSeconds: t.fixed_cooldown_seconds as number, maxUses24h: t.fixed_max_uses_24h as number | null,
    maxPoints24h: t.fixed_max_points_24h as number | null, maxUsesTotal: t.fixed_max_uses_total as number | null,
  };
}

/** Taps on a reader in fixed-amount mode: everybody gets the same number of points, within per-card limits. */
export function registerFixed(app: FastifyInstance) {
  const db = app.db;
  const photoUrl = (id: string) => `/cards/${id}/photo`;

  function statsFor(cardId: string, terminalId: string, nowMs: number): FixedStats {
    const since = new Date(nowMs - DAY_MS).toISOString();
    const base = "from transactions where card_id=? and terminal_id=? and kind='fixed' and type='give' and status='ok'";
    const day = db.prepare(`select count(*) n, coalesce(sum(amount),0) pts, min(created_at) oldest ${base} and created_at>=?`).get(cardId, terminalId, since) as { n: number; pts: number; oldest: string | null };
    const all = db.prepare(`select count(*) n, max(created_at) last ${base}`).get(cardId, terminalId) as { n: number; last: string | null };
    return { lastAtMs: all.last ? Date.parse(all.last) : null, uses24h: day.n, points24h: day.pts, usesTotal: all.n, oldestInWindowMs: day.oldest ? Date.parse(day.oldest) : null };
  }

  function view(action: string, card: CardRow, s: FixedSettings, st: FixedStats, extra: { points?: number; balanceBefore?: number; retryInSeconds?: number | null } = {}): Reply {
    return { status: 200, body: {
      action,
      card: { id: card.id, name: card.name, photoUrl: photoUrl(card.id), balance: card.balance },
      points: extra.points ?? 0, balanceBefore: extra.balanceBefore ?? card.balance, retryInSeconds: extra.retryInSeconds ?? null,
      limits: { uses24h: st.uses24h, maxUses24h: s.maxUses24h, points24h: st.points24h, maxPoints24h: s.maxPoints24h, usesTotal: st.usesTotal, maxUsesTotal: s.maxUsesTotal },
    } };
  }

  const tap = db.transaction((terminalId: string, uidInput: string, key: string): Reply => {
    const term = db.prepare('select * from terminals where id=?').get(terminalId) as Record<string, unknown>;
    if (term.mode !== 'fixed') return { status: 409, body: { error: 'This terminal is not in fixed-amount mode.', code: 'wrong_mode' } };
    const settings = fixedOf(term);

    // The same tap arriving twice (a lost reply, then a retry) gives the same answer and grants once.
    const prior = db.prepare("select * from transactions where terminal_id=? and idempotency_key=? and kind='fixed'").get(terminalId, key) as { card_id: string; amount: number; balance_after: number } | undefined;
    if (prior) {
      const card = db.prepare('select * from cards where id=?').get(prior.card_id) as CardRow;
      return view('granted', { ...card, balance: prior.balance_after }, settings, statsFor(card.id, terminalId, Date.now()), { points: prior.amount, balanceBefore: prior.balance_after - prior.amount });
    }

    const uid = normalizeUid(uidInput);
    const card = uid ? findCardByUid(db, uid) : undefined;
    if (!card) {
      if (uid) recordSuggestion(db, uid, terminalId);
      return { status: 404, body: { error: 'Card not registered', code: 'unknown_card' } };
    }
    if (card.status === 'blocked') return { status: 403, body: { error: 'Card is blocked', code: 'card_blocked', card: { name: card.name, photoUrl: photoUrl(card.id) } } };

    const now = stamp();
    const st = statsFor(card.id, terminalId, now.getTime());
    const verdict = evaluateFixed(settings, st, now.getTime());
    if (!verdict.ok) return view(verdict.action, card, settings, st, { retryInSeconds: verdict.retryInSeconds });

    const iso = now.toISOString();
    const after = card.balance + settings.amount;
    db.prepare('update cards set balance=?, last_used=? where id=?').run(after, iso, card.id);
    db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,operator_id,idempotency_key,created_at,balance_after,kind)
      values(?,?,'give','ok',?,NULL,?,?,?,'fixed')`).run(card.id, settings.amount, terminalId, key, iso, after);
    return view('granted', { ...card, balance: after }, settings,
      { ...st, uses24h: st.uses24h + 1, points24h: st.points24h + settings.amount, usesTotal: st.usesTotal + 1 },
      { points: settings.amount, balanceBefore: card.balance });
  });

  app.post('/fixed/tap', { preHandler: app.requireOperator }, async (req, reply) => {
    const b = (req.body ?? {}) as { cardUid?: string; idempotencyKey?: unknown };
    if (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 100) {
      return reply.code(400).send({ error: 'idempotencyKey is required', code: 'bad_request' });
    }
    const r = tap(req.user.terminalId!, b.cardUid ?? '', b.idempotencyKey);
    return reply.code(r.status).send(r.body);
  });
}
