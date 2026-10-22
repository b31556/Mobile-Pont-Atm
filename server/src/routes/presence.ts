import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { normalizeUid } from '../uid.js';
import { findCardByUid, type CardRow } from './cards.js';
import { recordSuggestion } from './suggestions.js';
import { computePoints, getSettings, saveSettings, validateSettings, type PresenceSettings } from '../presence.js';

interface SessionRow {
  id: number; card_id: string; in_at: string; in_terminal: string | null; in_key: string | null; expired_minutes: number | null;
  out_at: string | null; out_terminal: string | null; out_key: string | null; minutes: number | null; points: number; raw: number;
  capped_by: string | null; day_total: number; balance_after: number | null; status: string; tx_id: number | null;
}
type Reply = { status: number; body: object };
const photoUrl = (cardId: string) => `/cards/${cardId}/photo`;
const DAY_MS = 24 * 3600 * 1000;

/** Points from presence awards in the last 24 h that were not stornoed. */
function earned24h(db: Db, cardId: string, nowMs: number): number {
  const since = new Date(nowMs - DAY_MS).toISOString();
  return (db.prepare("select coalesce(sum(amount),0) s from transactions where card_id=? and kind='presence' and type='give' and status='ok' and created_at>=?")
    .get(cardId, since) as { s: number }).s;
}

function openSession(db: Db, cardId: string, terminalId: string | null, key: string | null, nowIso: string, expiredMinutes: number | null): SessionRow {
  const id = db.prepare("insert into presence_sessions(card_id,in_at,in_terminal,in_key,expired_minutes,status) values(?,?,?,?,?,'open')")
    .run(cardId, nowIso, terminalId, key, expiredMinutes).lastInsertRowid;
  return db.prepare('select * from presence_sessions where id=?').get(id) as SessionRow;
}

/** Closes an open visit and pays for it under the saved rules. [terminalId] and [key] are null when an admin does it. */
function checkOut(db: Db, s: SessionRow, card: CardRow, settings: PresenceSettings, now: Date, terminalId: string | null, key: string | null): SessionRow {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000));
  const earned = earned24h(db, card.id, now.getTime());
  const remaining = settings.maxPoints24h === null ? null : Math.max(0, settings.maxPoints24h - earned);
  const r = computePoints(settings, minutes, remaining);
  const iso = now.toISOString();
  let balance = card.balance;
  let txId: number | null = null;
  if (r.awarded > 0) {
    balance += r.awarded;
    db.prepare('update cards set balance=?, last_used=? where id=?').run(balance, iso, card.id);
    txId = Number(db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,operator_id,created_at,balance_after,kind,note)
      values(?,?,'give','ok',?,NULL,?,?,'presence',?)`).run(card.id, r.awarded, terminalId, iso, balance, `${minutes} min`).lastInsertRowid);
  }
  db.prepare(`update presence_sessions set out_at=?, out_terminal=?, out_key=?, minutes=?, points=?, raw=?, capped_by=?, day_total=?, balance_after=?, status='closed', tx_id=? where id=?`)
    .run(iso, terminalId, key, minutes, r.awarded, r.raw, r.cappedBy, earned + r.awarded, balance, txId, s.id);
  return db.prepare('select * from presence_sessions where id=?').get(s.id) as SessionRow;
}

export function registerPresence(app: FastifyInstance) {
  const db = app.db;
  const terminalName = (id: string | null) => id ? (db.prepare('select name from terminals where id=?').get(id) as { name: string } | undefined)?.name ?? '' : '';
  const cardById = (id: string) => db.prepare('select * from cards where id=?').get(id) as CardRow;

  function view(action: string, s: SessionRow, card: CardRow, settings: PresenceSettings, extra: object = {}): Reply {
    const closed = action === 'out';
    return { status: 200, body: {
      action,
      card: { id: card.id, name: card.name, photoUrl: photoUrl(card.id), balance: closed ? s.balance_after ?? card.balance : card.balance },
      inAt: s.in_at, outAt: s.out_at ?? undefined, minutes: s.minutes ?? undefined,
      points: closed ? s.points : 0, raw: closed ? s.raw : 0, cappedBy: closed ? s.capped_by : null,
      today: { earned: closed ? s.day_total : earned24h(db, card.id, Date.now()), max: settings.maxPoints24h },
      ...extra,
    } };
  }

  const tap = db.transaction((terminalId: string, uidInput: string, key: string): Reply => {
    const mode = (db.prepare('select mode from terminals where id=?').get(terminalId) as { mode: string }).mode;
    if (mode !== 'presence') return { status: 409, body: { error: 'This terminal is not in check-in mode.', code: 'wrong_mode' } };
    const settings = getSettings(db);

    // The same tap arriving twice (a lost reply, then a retry) must give the same answer and change nothing.
    const byIn = db.prepare('select * from presence_sessions where in_terminal=? and in_key=?').get(terminalId, key) as SessionRow | undefined;
    if (byIn) return view(byIn.expired_minutes !== null ? 'expired_in' : 'in', byIn, cardById(byIn.card_id), settings, byIn.expired_minutes !== null ? { expiredMinutes: byIn.expired_minutes } : {});
    const byOut = db.prepare('select * from presence_sessions where out_terminal=? and out_key=?').get(terminalId, key) as SessionRow | undefined;
    if (byOut) return view('out', byOut, cardById(byOut.card_id), settings);

    const uid = normalizeUid(uidInput);
    const card = uid ? findCardByUid(db, uid) : undefined;
    if (!card) {
      if (uid) recordSuggestion(db, uid, terminalId);
      return { status: 404, body: { error: 'Card not registered', code: 'unknown_card' } };
    }
    if (card.status === 'blocked') return { status: 403, body: { error: 'Card is blocked', code: 'card_blocked', card: { name: card.name, photoUrl: photoUrl(card.id) } } };

    const now = new Date();
    const open = db.prepare("select * from presence_sessions where card_id=? and status='open'").get(card.id) as SessionRow | undefined;
    if (!open) return view('in', openSession(db, card.id, terminalId, key, now.toISOString(), null), card, settings);

    const ageSeconds = (now.getTime() - Date.parse(open.in_at)) / 1000;
    if (ageSeconds < settings.cooldownSeconds) return view('cooldown', open, card, settings);
    if (ageSeconds > settings.maxStayHours * 3600) {
      const minutes = Math.floor(ageSeconds / 60);
      db.prepare("update presence_sessions set status='expired', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, open.id);
      return view('expired_in', openSession(db, card.id, terminalId, key, now.toISOString(), minutes), card, settings, { expiredMinutes: minutes });
    }
    return view('out', checkOut(db, open, card, settings, now, terminalId, key), card, settings);
  });

  app.get('/terminal/config', { preHandler: app.requireOperator }, async req =>
    db.prepare('select mode, name from terminals where id=?').get(req.user.terminalId));

  app.post('/presence/tap', { preHandler: app.requireOperator }, async (req, reply) => {
    const b = (req.body ?? {}) as { cardUid?: string; idempotencyKey?: unknown };
    if (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 100) {
      return reply.code(400).send({ error: 'idempotencyKey is required', code: 'bad_request' });
    }
    const r = tap(req.user.terminalId!, b.cardUid ?? '', b.idempotencyKey);
    return reply.code(r.status).send(r.body);
  });

  app.get('/presence/settings', { preHandler: app.requireAdmin }, async () => getSettings(db));

  app.put('/presence/settings', { preHandler: app.requireAdmin }, async (req, reply) => {
    const v = validateSettings(req.body);
    if (!v.ok) return reply.code(400).send({ error: v.error });
    saveSettings(db, v.value);
    return v.value;
  });

  app.post('/presence/preview', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { settings?: unknown; minutes?: unknown };
    if (!Array.isArray(b.minutes) || b.minutes.length === 0 || b.minutes.length > 50 || !b.minutes.every(m => Number.isInteger(m) && m >= 0 && m <= 100000)) {
      return reply.code(400).send({ error: 'minutes must be a list of up to 50 whole numbers' });
    }
    let settings = getSettings(db);
    if (b.settings !== undefined) {
      const v = validateSettings(b.settings);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      settings = v.value;
    }
    return (b.minutes as number[]).map(minutes => ({ minutes, ...computePoints(settings, minutes, null) }));
  });

  app.get('/presence/sessions', { preHandler: app.requireAdmin }, async () => {
    const settings = getSettings(db);
    const nowMs = Date.now();
    const cardView = (s: SessionRow) => { const c = cardById(s.card_id); return { id: c.id, name: c.name, photoUrl: photoUrl(c.id) }; };
    const open = db.prepare("select * from presence_sessions where status='open' order by in_at").all() as SessionRow[];
    const recent = db.prepare("select * from presence_sessions where status!='open' order by id desc limit 50").all() as SessionRow[];
    return {
      inside: open.map(s => {
        const minutes = Math.max(0, Math.floor((nowMs - Date.parse(s.in_at)) / 60000));
        const remaining = settings.maxPoints24h === null ? null : Math.max(0, settings.maxPoints24h - earned24h(db, s.card_id, nowMs));
        return { id: s.id, card: cardView(s), inAt: s.in_at, terminal: terminalName(s.in_terminal), minutes,
          overdue: minutes > settings.maxStayHours * 60, wouldEarn: computePoints(settings, minutes, remaining).awarded };
      }),
      recent: recent.map(s => ({ id: s.id, card: cardView(s), inAt: s.in_at, outAt: s.out_at, minutes: s.minutes, points: s.points, status: s.status, terminal: terminalName(s.out_terminal ?? s.in_terminal) })),
    };
  });

  app.post('/presence/sessions/:id/close', { preHandler: app.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const award = (req.body as { award?: unknown } | undefined)?.award === true;
    const settings = getSettings(db);
    const result = db.transaction(() => {
      const s = db.prepare("select * from presence_sessions where id=? and status='open'").get(id) as SessionRow | undefined;
      if (!s) return null;
      if (award) return checkOut(db, s, cardById(s.card_id), settings, new Date(), null, null).points;
      const now = new Date();
      db.prepare("update presence_sessions set status='discarded', out_at=?, minutes=?, points=0 where id=?")
        .run(now.toISOString(), Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000)), id);
      return 0;
    })();
    if (result === null) return reply.code(404).send({ error: 'No open visit with that id' });
    return { ok: true, points: result };
  });
}
