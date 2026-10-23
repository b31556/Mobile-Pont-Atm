import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { stamp } from '../clock.js';
import { normalizeUid } from '../uid.js';
import { findCardByUid, type CardRow } from './cards.js';
import { publishTap } from './display.js';
import { recordSuggestion } from './suggestions.js';
import { computePoints, createZone, defaultZone, getZone, listZones, updateZone, validateSettings, DEFAULT_SETTINGS, type Zone } from '../presence.js';

interface SessionRow {
  id: number; card_id: string; zone_id: string | null; in_at: string; in_terminal: string | null; in_key: string | null; expired_minutes: number | null;
  out_at: string | null; out_terminal: string | null; out_key: string | null; minutes: number | null; points: number; raw: number;
  capped_by: string | null; day_total: number; balance_after: number | null; status: string; tx_id: number | null;
}
interface TerminalRow { mode: string; zone_id: string | null; direction: 'in' | 'out' | 'toggle' }
type Reply = { status: number; body: object };
const photoUrl = (cardId: string) => `/cards/${cardId}/photo`;
const DAY_MS = 24 * 3600 * 1000;

/** Points a card earned in a zone in the last 24 h from presence awards that were not stornoed. */
function earned24h(db: Db, cardId: string, zoneId: string, nowMs: number): number {
  const since = new Date(nowMs - DAY_MS).toISOString();
  return (db.prepare("select coalesce(sum(amount),0) s from transactions where card_id=? and zone_id=? and kind='presence' and type='give' and status='ok' and created_at>=?")
    .get(cardId, zoneId, since) as { s: number }).s;
}

function openSession(db: Db, cardId: string, zoneId: string, terminalId: string | null, key: string | null, nowIso: string, expiredMinutes: number | null): SessionRow {
  const id = db.prepare("insert into presence_sessions(card_id,zone_id,in_at,in_terminal,in_key,expired_minutes,status) values(?,?,?,?,?,?,'open')")
    .run(cardId, zoneId, nowIso, terminalId, key, expiredMinutes).lastInsertRowid;
  return db.prepare('select * from presence_sessions where id=?').get(id) as SessionRow;
}

/** Closes an open visit and pays for it under the rules of the zone it began in. [terminalId] and [key] are null when an admin does it. */
function checkOut(db: Db, s: SessionRow, card: CardRow, zone: Zone, now: Date, terminalId: string | null, key: string | null): SessionRow {
  const settings = zone.settings;
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000));
  const earned = earned24h(db, card.id, zone.id, now.getTime());
  const remaining = settings.maxPoints24h === null ? null : Math.max(0, settings.maxPoints24h - earned);
  const r = computePoints(settings, minutes, remaining);
  const iso = now.toISOString();
  let balance = card.balance;
  let txId: number | null = null;
  if (r.awarded > 0) {
    balance += r.awarded;
    db.prepare('update cards set balance=?, last_used=? where id=?').run(balance, iso, card.id);
    txId = Number(db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,operator_id,created_at,balance_after,kind,note,zone_id)
      values(?,?,'give','ok',?,NULL,?,?,'presence',?,?)`).run(card.id, r.awarded, terminalId, iso, balance, `${minutes} min`, zone.id).lastInsertRowid);
  }
  db.prepare(`update presence_sessions set out_at=?, out_terminal=?, out_key=?, minutes=?, points=?, raw=?, capped_by=?, day_total=?, balance_after=?, status='closed', tx_id=? where id=?`)
    .run(iso, terminalId, key, minutes, r.awarded, r.raw, r.cappedBy, earned + r.awarded, balance, txId, s.id);
  return db.prepare('select * from presence_sessions where id=?').get(s.id) as SessionRow;
}

export function registerPresence(app: FastifyInstance) {
  const db = app.db;
  const terminalName = (id: string | null) => id ? (db.prepare('select name from terminals where id=?').get(id) as { name: string } | undefined)?.name ?? '' : '';
  const cardById = (id: string) => db.prepare('select * from cards where id=?').get(id) as CardRow;
  const zoneOf = (s: SessionRow): Zone => (s.zone_id ? getZone(db, s.zone_id) : undefined) ?? defaultZone(db);
  const terminalZone = (t: TerminalRow): Zone => (t.zone_id ? getZone(db, t.zone_id) : undefined) ?? defaultZone(db);

  /** The answer for a phone. [action] says what happened; the card, zone and the day's points come with it. */
  function view(action: string, s: SessionRow | null, card: CardRow, zone: Zone, extra: object = {}): Reply {
    const closed = action === 'out';
    return { status: 200, body: {
      action,
      card: { id: card.id, name: card.name, photoUrl: photoUrl(card.id), balance: closed && s ? s.balance_after ?? card.balance : card.balance },
      zone: { id: zone.id, name: zone.name },
      inAt: s?.in_at, outAt: s?.out_at ?? undefined, minutes: s?.minutes ?? undefined,
      points: closed && s ? s.points : 0, raw: closed && s ? s.raw : 0, cappedBy: closed && s ? s.capped_by : null,
      today: { earned: closed && s ? s.day_total : earned24h(db, card.id, zone.id, Date.now()), max: zone.settings.maxPoints24h },
      ...extra,
    } };
  }

  const tap = db.transaction((terminalId: string, uidInput: string, key: string): Reply => {
    const term = db.prepare('select mode, zone_id, direction from terminals where id=?').get(terminalId) as TerminalRow;
    if (term.mode !== 'presence') return { status: 409, body: { error: 'This terminal is not in check-in mode.', code: 'wrong_mode' } };
    const here = terminalZone(term);

    // The same tap arriving twice (a lost reply, then a retry) must give the same answer and change nothing.
    const byIn = db.prepare('select * from presence_sessions where in_terminal=? and in_key=?').get(terminalId, key) as SessionRow | undefined;
    if (byIn) return view(byIn.expired_minutes !== null ? 'expired_in' : 'in', byIn, cardById(byIn.card_id), zoneOf(byIn), byIn.expired_minutes !== null ? { expiredMinutes: byIn.expired_minutes } : {});
    const byOut = db.prepare('select * from presence_sessions where out_terminal=? and out_key=?').get(terminalId, key) as SessionRow | undefined;
    if (byOut) return byOut.status === 'expired'
      ? view('expired_out', byOut, cardById(byOut.card_id), zoneOf(byOut), { expiredMinutes: byOut.minutes })
      : view('out', byOut, cardById(byOut.card_id), zoneOf(byOut));

    const uid = normalizeUid(uidInput);
    const card = uid ? findCardByUid(db, uid) : undefined;
    if (!card) {
      if (uid) recordSuggestion(db, uid, terminalId);
      return { status: 404, body: { error: 'Card not registered', code: 'unknown_card' } };
    }
    if (card.status === 'blocked') return { status: 403, body: { error: 'Card is blocked', code: 'card_blocked', card: { name: card.name, photoUrl: photoUrl(card.id) } } };

    const now = stamp();
    const open = db.prepare("select * from presence_sessions where card_id=? and status='open'").get(card.id) as SessionRow | undefined;
    if (!open) {
      if (term.direction === 'out') return view('not_in', null, card, here);
      return view('in', openSession(db, card.id, here.id, terminalId, key, now.toISOString(), null), card, here);
    }

    // Someone is inside: the zone they went into decides the lock-out, the longest stay and the pay.
    const visitZone = zoneOf(open);
    const rules = visitZone.settings;
    const ageSeconds = (now.getTime() - Date.parse(open.in_at)) / 1000;
    if (ageSeconds < rules.cooldownSeconds) return view('cooldown', open, card, visitZone);
    if (ageSeconds > rules.maxStayHours * 3600) {
      const minutes = Math.floor(ageSeconds / 60);
      if (term.direction === 'out') {
        db.prepare("update presence_sessions set status='expired', out_at=?, out_terminal=?, out_key=?, minutes=?, points=0 where id=?").run(now.toISOString(), terminalId, key, minutes, open.id);
        return view('expired_out', db.prepare('select * from presence_sessions where id=?').get(open.id) as SessionRow, card, visitZone, { expiredMinutes: minutes });
      }
      db.prepare("update presence_sessions set status='expired', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, open.id);
      return view('expired_in', openSession(db, card.id, here.id, terminalId, key, now.toISOString(), minutes), card, here, { expiredMinutes: minutes });
    }
    if (term.direction === 'in') return view('already_in', open, card, visitZone);
    return view('out', checkOut(db, open, card, visitZone, now, terminalId, key), card, visitZone);
  });

  app.get('/terminal/config', { preHandler: app.requireOperator }, async req => {
    const t = db.prepare('select mode, name, direction, zone_id, kind from terminals where id=?').get(req.user.terminalId) as { mode: string; name: string; direction: string; zone_id: string | null; kind: string };
    const zone = t.mode === 'presence' ? terminalZone(t as unknown as TerminalRow) : t.zone_id ? getZone(db, t.zone_id) : undefined;
    return { mode: t.mode, name: t.name, direction: t.direction, zoneName: zone?.name ?? null, kind: t.kind };
  });

  app.post('/presence/tap', { preHandler: app.requireOperator }, async (req, reply) => {
    const b = (req.body ?? {}) as { cardUid?: string; idempotencyKey?: unknown };
    if (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 100) {
      return reply.code(400).send({ error: 'idempotencyKey is required', code: 'bad_request' });
    }
    const r = tap(req.user.terminalId!, b.cardUid ?? '', b.idempotencyKey);
    publishTap(app, req.user.terminalId, 'presence', r);
    return reply.code(r.status).send(r.body);
  });

  // ---- zones ----
  const zoneJson = (z: Zone) => ({
    ...z,
    terminals: (db.prepare('select count(*) c from terminals where zone_id=? and active=1').get(z.id) as { c: number }).c,
    inside: (db.prepare("select count(*) c from presence_sessions where zone_id=? and status='open'").get(z.id) as { c: number }).c,
  });
  const nameTaken = (name: string, exceptId?: string) =>
    !!db.prepare('select 1 from zones where name=? collate nocase and id!=?').get(name, exceptId ?? '');

  app.get('/zones', { preHandler: app.requireAdmin }, async () => listZones(db).map(zoneJson));

  app.post('/zones', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; settings?: unknown };
    const name = (b.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Give the zone a name' });
    if (nameTaken(name)) return reply.code(409).send({ error: 'A zone with that name already exists' });
    let settings = { ...DEFAULT_SETTINGS };
    if (b.settings !== undefined) {
      const v = validateSettings(b.settings);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      settings = v.value;
    }
    return reply.code(201).send(zoneJson(createZone(db, name, settings)));
  });

  app.put('/zones/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; settings?: unknown };
    if (!getZone(db, id)) return reply.code(404).send({ error: 'Zone not found' });
    const change: Partial<Pick<Zone, 'name' | 'settings'>> = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name) return reply.code(400).send({ error: 'Give the zone a name' });
      if (nameTaken(name, id)) return reply.code(409).send({ error: 'A zone with that name already exists' });
      change.name = name;
    }
    if (b.settings !== undefined) {
      const v = validateSettings(b.settings);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      change.settings = v.value;
    }
    return zoneJson(updateZone(db, id, change)!);
  });

  app.delete('/zones/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getZone(db, id)) return reply.code(404).send({ error: 'Zone not found' });
    if (listZones(db).length === 1) return reply.code(409).send({ error: 'There has to be at least one zone.' });
    const terminals = (db.prepare('select count(*) c from terminals where zone_id=? and active=1').get(id) as { c: number }).c;
    if (terminals) return reply.code(409).send({ error: `${terminals} terminal${terminals === 1 ? ' uses' : 's use'} this zone. Move ${terminals === 1 ? 'it' : 'them'} to another zone first.` });
    const visits = (db.prepare('select count(*) c from presence_sessions where zone_id=?').get(id) as { c: number }).c;
    if (visits) return reply.code(409).send({ error: 'This zone has visit history, so it can’t be deleted. Rename it instead.' });
    db.prepare('update terminals set zone_id=NULL where zone_id=?').run(id);
    db.prepare('delete from zones where id=?').run(id);
    return { ok: true };
  });

  app.post('/presence/preview', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { settings?: unknown; zoneId?: string; minutes?: unknown };
    if (!Array.isArray(b.minutes) || b.minutes.length === 0 || b.minutes.length > 50 || !b.minutes.every(m => Number.isInteger(m) && m >= 0 && m <= 100000)) {
      return reply.code(400).send({ error: 'minutes must be a list of up to 50 whole numbers' });
    }
    let settings = defaultZone(db).settings;
    if (b.settings !== undefined) {
      const v = validateSettings(b.settings);
      if (!v.ok) return reply.code(400).send({ error: v.error });
      settings = v.value;
    } else if (b.zoneId !== undefined) {
      const z = getZone(db, b.zoneId);
      if (!z) return reply.code(404).send({ error: 'Zone not found' });
      settings = z.settings;
    }
    return (b.minutes as number[]).map(minutes => ({ minutes, ...computePoints(settings, minutes, null) }));
  });

  app.get('/presence/sessions', { preHandler: app.requireAdmin }, async () => {
    const nowMs = Date.now();
    const cardView = (s: SessionRow) => { const c = cardById(s.card_id); return { id: c.id, name: c.name, photoUrl: photoUrl(c.id) }; };
    const open = db.prepare("select * from presence_sessions where status='open' order by in_at").all() as SessionRow[];
    const recent = db.prepare("select * from presence_sessions where status!='open' order by id desc limit 50").all() as SessionRow[];
    return {
      inside: open.map(s => {
        const zone = zoneOf(s);
        const minutes = Math.max(0, Math.floor((nowMs - Date.parse(s.in_at)) / 60000));
        const remaining = zone.settings.maxPoints24h === null ? null : Math.max(0, zone.settings.maxPoints24h - earned24h(db, s.card_id, zone.id, nowMs));
        return { id: s.id, card: cardView(s), zone: zone.name, inAt: s.in_at, terminal: terminalName(s.in_terminal), minutes,
          overdue: minutes > zone.settings.maxStayHours * 60, wouldEarn: computePoints(zone.settings, minutes, remaining).awarded };
      }),
      recent: recent.map(s => ({ id: s.id, card: cardView(s), zone: zoneOf(s).name, inAt: s.in_at, outAt: s.out_at, minutes: s.minutes, points: s.points, status: s.status, terminal: terminalName(s.out_terminal ?? s.in_terminal) })),
    };
  });

  app.post('/presence/sessions/:id/close', { preHandler: app.requireAdmin }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const award = (req.body as { award?: unknown } | undefined)?.award === true;
    const result = db.transaction(() => {
      const s = db.prepare("select * from presence_sessions where id=? and status='open'").get(id) as SessionRow | undefined;
      if (!s) return null;
      const now = stamp();
      const zone = zoneOf(s);
      const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000));
      // The same rule as at a terminal: a visit longer than the zone's longest stay earns nothing, even when an admin closes it.
      if (award && minutes > zone.settings.maxStayHours * 60) {
        db.prepare("update presence_sessions set status='expired', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, id);
        return 0;
      }
      if (award) return checkOut(db, s, cardById(s.card_id), zone, now, null, null).points;
      db.prepare("update presence_sessions set status='discarded', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, id);
      return 0;
    })();
    if (result === null) return reply.code(404).send({ error: 'No open visit with that id' });
    return { ok: true, points: result };
  });
}
