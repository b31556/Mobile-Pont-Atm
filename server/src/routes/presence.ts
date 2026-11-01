import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { stamp } from '../clock.js';
import { normalizeUid } from '../uid.js';
import { findCardByUid, type CardRow } from './cards.js';
import { publishCancelled, publishTap } from './display.js';
import type { Canceller } from '../storno.js';
import { recordSuggestion } from './suggestions.js';
import { computePoints, createZone, defaultZone, getZone, listZones, updateZone, validateSettings, DEFAULT_SETTINGS, type PresenceSettings, type Zone } from '../presence.js';

interface SessionRow {
  id: number; card_id: string; zone_id: string | null; in_at: string; in_terminal: string | null; in_key: string | null; expired_minutes: number | null;
  out_at: string | null; out_terminal: string | null; out_key: string | null; minutes: number | null; points: number; raw: number;
  capped_by: string | null; day_total: number; balance_after: number | null; status: string; tx_id: number | null;
}
interface TerminalRow { mode: string; zone_id: string | null; direction: 'in' | 'out' | 'toggle' }
type Reply = { status: number; body: object; replayed?: boolean };
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

/**
 * Closes an open visit for an admin (or "everyone in this zone"): with [award] it pays like a normal check-out, unless the visit
 * lasted longer than the zone's longest stay (that earns nothing, as at a terminal); without it the visit is discarded, no points.
 */
export function closeOpenVisit(db: Db, s: SessionRow, award: boolean, now: Date): { points: number; overdue: boolean } {
  const zone = (s.zone_id ? getZone(db, s.zone_id) : undefined) ?? defaultZone(db);
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000));
  if (award && minutes > zone.settings.maxStayHours * 60) {
    db.prepare("update presence_sessions set status='expired', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, s.id);
    return { points: 0, overdue: true };
  }
  if (award) return { points: checkOut(db, s, db.prepare('select * from cards where id=?').get(s.card_id) as CardRow, zone, now, null, null).points, overdue: false };
  db.prepare("update presence_sessions set status='discarded', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, s.id);
  return { points: 0, overdue: false };
}

/**
 * Cancels a check-in (the visit is discarded, no points) or a check-out (the points are taken back and the visit is open again, as if
 * the card had not tapped out). An operator may only cancel what happened at its own terminal; an admin anything.
 * [expect] says what the caller means to cancel; if the visit is no longer like that (a double tap, someone else got there first)
 * nothing happens, so cancelling a check-out twice can never go on to discard the reopened visit.
 */
export function cancelVisit(db: Db, id: number, who: Canceller, expect: 'in' | 'out'): { status: number; body: object } {
  return db.transaction((): { status: number; body: object } => {
    const s = db.prepare('select * from presence_sessions where id=?').get(id) as SessionRow | undefined;
    if (!s) return { status: 404, body: { error: 'Visit not found', code: 'not_found' } };
    const zone = (s.zone_id ? getZone(db, s.zone_id) : undefined) ?? defaultZone(db);
    const card = db.prepare('select * from cards where id=?').get(s.card_id) as CardRow;
    const mine = (terminal: string | null) => who.role !== 'operator' || terminal === who.terminalId;
    const answer = (action: string, balance: number, points: number) => ({ status: 200, body: {
      action, points, card: { id: card.id, name: card.name, photoUrl: photoUrl(card.id), balance }, zone: { id: zone.id, name: zone.name },
    } });
    const now = stamp();

    const changed = { status: 409, body: { error: 'That visit has changed since, so nothing was cancelled.', code: 'state_changed' } };
    if (s.status === 'open') {
      if (expect !== 'in') return changed;
      if (!mine(s.in_terminal)) return { status: 403, body: { error: 'That check-in was made on another terminal', code: 'other_terminal' } };
      const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(s.in_at)) / 60000));
      db.prepare("update presence_sessions set status='discarded', out_at=?, minutes=?, points=0 where id=?").run(now.toISOString(), minutes, s.id);
      return answer('cancelled_in', card.balance, 0);
    }
    if (s.status === 'closed') {
      if (expect !== 'out') return changed;
      if (!mine(s.out_terminal)) return { status: 403, body: { error: 'That check-out was made on another terminal', code: 'other_terminal' } };
      if (db.prepare("select 1 from presence_sessions where card_id=? and status='open'").get(s.card_id)) {
        return { status: 409, body: { error: 'This card has checked in somewhere else since, so that visit cannot be reopened.', code: 'inside_elsewhere' } };
      }
      let balance = card.balance;
      if (s.points > 0 && s.tx_id) {
        if (card.balance < s.points) return { status: 400, body: { error: 'Card has fewer points than this check-out paid.', code: 'would_go_negative' } };
        balance = card.balance - s.points;
        db.prepare('update cards set balance=? where id=?').run(balance, card.id);
        db.prepare("update transactions set status='stornoed' where id=?").run(s.tx_id);
        db.prepare(`insert into transactions(card_id,amount,type,status,ref,terminal_id,operator_id,created_at,balance_after,note,zone_id)
          values(?,?,'storno','ok',?,?,?,?,?,?,?)`).run(card.id, -s.points, s.tx_id, who.terminalId ?? s.out_terminal, who.viaTerminal ? null : who.id, now.toISOString(), balance, 'Check-out cancelled', zone.id);
      }
      db.prepare(`update presence_sessions set status='open', out_at=NULL, out_terminal=NULL, out_key=NULL, minutes=NULL, points=0, raw=0,
        capped_by=NULL, day_total=0, balance_after=NULL, tx_id=NULL where id=?`).run(s.id);
      return answer('cancelled_out', balance, s.points);
    }
    return { status: 400, body: { error: 'Nothing to cancel: that visit was not an ordinary check-in or check-out.', code: 'nothing_to_cancel' } };
  })();
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
      action, sessionId: s?.id,
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
    if (byIn) {
      const dropped = db.prepare("select * from presence_sessions where out_terminal=? and out_key=? and status='discarded'").get(terminalId, key) as SessionRow | undefined;
      const extra = byIn.expired_minutes !== null ? { expiredMinutes: byIn.expired_minutes } : dropped ? { discarded: { zone: zoneOf(dropped).name, minutes: dropped.minutes ?? 0 } } : {};
      return { ...view(byIn.expired_minutes !== null ? 'expired_in' : 'in', byIn, cardById(byIn.card_id), zoneOf(byIn), extra), replayed: true };
    }
    const byOut = db.prepare('select * from presence_sessions where out_terminal=? and out_key=?').get(terminalId, key) as SessionRow | undefined;
    if (byOut) return {
      ...(byOut.status === 'expired'
        ? view('expired_out', byOut, cardById(byOut.card_id), zoneOf(byOut), { expiredMinutes: byOut.minutes })
        : view('out', byOut, cardById(byOut.card_id), zoneOf(byOut))),
      replayed: true,
    };

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
    // Tapping in (or at a toggle point) of ANOTHER zone while still inside one: nobody is in two places, so the old visit is discarded
    // (no points for it) and the card is signed into this zone. The answer says so, so the person and the staff are warned.
    if (visitZone.id !== here.id && term.direction !== 'out' && ageSeconds <= rules.maxStayHours * 3600) {
      const minutes = Math.floor(ageSeconds / 60);
      db.prepare("update presence_sessions set status='discarded', out_at=?, out_terminal=?, out_key=?, minutes=?, points=0 where id=?").run(now.toISOString(), terminalId, key, minutes, open.id);
      return view('in', openSession(db, card.id, here.id, terminalId, key, now.toISOString(), null), card, here, { discarded: { zone: visitZone.name, minutes } });
    }
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
    if (!r.replayed) publishTap(app, req.user.terminalId, 'presence', r);
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

  /**
   * Many zones at once, from a pasted file: { zones: [{ name, settings }] }. A zone whose name exists (any letter case) gets its settings
   * replaced, any other name makes a new zone; nothing is ever deleted. Each zone is checked the way POST /zones checks it, and if
   * any one is wrong nothing at all is changed. Without `settings` a new zone gets the default rules and an old one keeps its own.
   */
  app.post('/zones/import', { preHandler: app.requireAdmin }, async (req, reply) => {
    const list = (req.body as { zones?: unknown } | null | undefined)?.zones;
    if (!Array.isArray(list) || list.length === 0) return reply.code(400).send({ error: 'Send { "zones": [ { "name": ..., "settings": { ... } } ] } with at least one zone' });
    if (list.length > 100) return reply.code(400).send({ error: 'At most 100 zones can be imported at once' });
    const checked: { name: string; settings?: PresenceSettings }[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of list.entries()) {
      const z = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; settings?: unknown };
      const name = typeof z.name === 'string' ? z.name.trim() : '';
      if (!name) return reply.code(400).send({ error: `Zone ${i + 1}: give the zone a name` });
      if (seen.has(name.toLowerCase())) return reply.code(400).send({ error: `Zone “${name}”: the name is listed twice` });
      seen.add(name.toLowerCase());
      if (z.settings === undefined) { checked.push({ name }); continue; }
      const v = validateSettings(z.settings);
      if (!v.ok) return reply.code(400).send({ error: `Zone “${name}”: ${v.error}` });
      checked.push({ name, settings: v.value });
    }
    const done = db.transaction(() => {
      let created = 0, updated = 0;
      for (const z of checked) {
        const old = db.prepare('select id from zones where name=? collate nocase').get(z.name) as { id: string } | undefined;
        if (old) { if (z.settings) updateZone(db, old.id, { settings: z.settings }); updated++; }
        else { createZone(db, z.name, z.settings ?? { ...DEFAULT_SETTINGS }); created++; }
      }
      return { created, updated };
    })();
    return { ...done, zones: listZones(db).map(zoneJson) };
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
      return s ? closeOpenVisit(db, s, award, stamp()).points : null;
    })();
    if (result === null) return reply.code(404).send({ error: 'No open visit with that id' });
    return { ok: true, points: result };
  });

  /** Undo a check-in or a check-out (see cancelVisit). For a phone: the one it just did; for an admin: any. */
  app.post('/presence/sessions/:id/cancel', { preHandler: app.requireStaff }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const expect = (req.body as { expect?: unknown } | undefined)?.expect;
    if (expect !== 'in' && expect !== 'out') return reply.code(400).send({ error: 'Say what to cancel: expect must be "in" (a check-in) or "out" (a check-out)', code: 'bad_request' });
    const r = cancelVisit(db, id, { id: req.user.id, role: req.user.role, terminalId: req.user.terminalId, viaTerminal: req.user.viaTerminal }, expect);
    if (r.status === 200 && req.user.terminalId) {   // the screen next to the reader says so too
      const b = r.body as { card: { id: string; name: string }; action: string };
      publishCancelled(app, req.user.terminalId, b.card, b.action === 'cancelled_in' ? 'The check-in was cancelled.' : 'The check-out was cancelled: the points were taken back.');
    }
    return reply.code(r.status).send(r.body);
  });

  /** Everyone who is inside one zone: signed out (paid like a normal check-out) or discarded (no points), in one go. */
  app.post('/zones/:id/close-all', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const zone = getZone(db, id);
    if (!zone) return reply.code(404).send({ error: 'Zone not found' });
    const award = (req.body as { award?: unknown } | undefined)?.award === true;
    const isDefault = defaultZone(db).id === id;
    const done = db.transaction(() => {
      const open = db.prepare(`select * from presence_sessions where status='open' and (zone_id=? ${isDefault ? 'or zone_id is null' : ''}) order by id`).all(id) as SessionRow[];
      const now = stamp();
      let points = 0, overdue = 0;
      for (const s of open) { const r = closeOpenVisit(db, s, award, now); points += r.points; if (r.overdue) overdue++; }
      return { closed: open.length, points, overdue };
    })();
    return { ok: true, ...done };
  });
}
