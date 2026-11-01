import type { Db } from './db.js';
import { defaultZone } from './presence.js';

const MAX_VISITS = 2000, MAX_TX = 3000, MAX_ADJUSTMENTS = 1000;

/** One thing that happened to a card, as a line of the report and a mark on its timeline. [points] is signed. */
export interface ReportEvent {
  at: string;
  type: 'checkin' | 'checkout' | 'discard' | 'expired' | 'grant' | 'refund' | 'adjust';
  place: string;          // the terminal (or "Admin" for something done in the admin site)
  zone: string;
  points: number;
  minutes: number | null;
  note: string | null;
  by: string;             // who did it: a person if one was signed in, else the terminal
  visitId: number | null;
  txId: number | null;
  stornoed: boolean;      // a grant that was reversed
}

interface VisitRow {
  id: number; zone_id: string | null; in_at: string; in_terminal: string | null; out_at: string | null; out_terminal: string | null;
  minutes: number | null; points: number; raw: number; capped_by: string | null; status: string;
  zone_name: string | null; in_name: string | null; out_name: string | null;
}

/**
 * Everything that happened to one card: its visits (when, where, how long, how many points), its grants, refunds and
 * adjustments, totals, and the totals per zone. The totals add up to the balance: [opening] is whatever the card
 * started with before the log began (points typed in when the card was made).
 */
export function cardReport(db: Db, cardId: string, nowMs = Date.now()) {
  const card = db.prepare('select id, name, uid, balance, status from cards where id=?').get(cardId) as { id: string; name: string; uid: string; balance: number; status: string } | undefined;
  if (!card) return null;
  const fallbackZone = defaultZone(db).name;

  const visits = db.prepare(`select s.id, s.zone_id, s.in_at, s.in_terminal, s.out_at, s.out_terminal, s.minutes, s.points, s.raw, s.capped_by, s.status,
      z.name zone_name, ti.name in_name, tout.name out_name
    from presence_sessions s left join zones z on z.id=s.zone_id left join terminals ti on ti.id=s.in_terminal left join terminals tout on tout.id=s.out_terminal
    where s.card_id=? order by s.id desc limit ?`).all(cardId, MAX_VISITS + 1) as VisitRow[];
  const txRows = db.prepare(`select t.id, t.created_at, t.amount, t.type, t.status, t.kind, t.note, t.ref, tm.name terminal, z.name zone, st.name staff
    from transactions t left join terminals tm on tm.id=t.terminal_id left join zones z on z.id=t.zone_id left join staff st on st.id=t.operator_id
    where t.card_id=? order by t.id desc limit ?`).all(cardId, MAX_TX + 1) as
    { id: number; created_at: string; amount: number; type: string; status: string; kind: string | null; note: string | null; ref: number | null; terminal: string | null; zone: string | null; staff: string | null }[];
  const adjustments = db.prepare(`select a.id, a.created_at, a.delta, a.reason, st.name staff from balance_adjustments a left join staff st on st.id=a.staff_id
    where a.card_id=? order by a.created_at desc limit ?`).all(cardId, MAX_ADJUSTMENTS + 1) as { id: string; created_at: string; delta: number; reason: string | null; staff: string | null }[];
  const truncated = visits.length > MAX_VISITS || txRows.length > MAX_TX || adjustments.length > MAX_ADJUSTMENTS;
  visits.length = Math.min(visits.length, MAX_VISITS); txRows.length = Math.min(txRows.length, MAX_TX); adjustments.length = Math.min(adjustments.length, MAX_ADJUSTMENTS);

  const events: ReportEvent[] = [];
  const minutesOf = (v: VisitRow) => v.minutes ?? (v.status === 'open' ? Math.max(0, Math.floor((nowMs - Date.parse(v.in_at)) / 60000)) : null);
  const visitJson = visits.map(v => ({
    id: v.id, zone: v.zone_name ?? fallbackZone, status: v.status, inAt: v.in_at, inPlace: v.in_name ?? '', outAt: v.out_at, outPlace: v.out_name ?? (v.out_at ? 'Admin' : ''),
    minutes: minutesOf(v), points: v.points, raw: v.raw, cappedBy: v.capped_by,
  }));
  for (const v of visits) {
    const zone = v.zone_name ?? fallbackZone;
    events.push({ at: v.in_at, type: 'checkin', place: v.in_name ?? '', zone, points: 0, minutes: null, note: null, by: v.in_name ?? '', visitId: v.id, txId: null, stornoed: false });
    if (!v.out_at) continue;
    const out = v.out_name ?? 'Admin';
    if (v.status === 'closed') events.push({ at: v.out_at, type: 'checkout', place: out, zone, points: v.points, minutes: v.minutes, note: v.capped_by === 'visit' ? 'Visit limit reached' : v.capped_by === '24h' ? 'Daily limit reached' : null, by: out, visitId: v.id, txId: null, stornoed: false });
    else if (v.status === 'discarded') events.push({ at: v.out_at, type: 'discard', place: out, zone, points: 0, minutes: v.minutes, note: 'Visit cancelled, no points', by: out, visitId: v.id, txId: null, stornoed: false });
    else if (v.status === 'expired') events.push({ at: v.out_at, type: 'expired', place: out, zone, points: 0, minutes: v.minutes, note: 'Not signed out in time, no points', by: out, visitId: v.id, txId: null, stornoed: false });
  }
  for (const t of txRows) {
    // A check-out that stands is already shown from its visit; one that was cancelled is shown here, struck through, next to its reversal.
    if (t.type === 'give' && t.kind === 'presence') {
      if (t.status === 'stornoed') events.push({ at: t.created_at, type: 'checkout', place: t.terminal ?? '', zone: t.zone ?? '', points: t.amount, minutes: Number.parseInt(t.note ?? '') || null, note: 'Check-out cancelled', by: t.terminal ?? '', visitId: null, txId: t.id, stornoed: true });
      continue;
    }
    const refund = t.type === 'storno';
    events.push({
      at: t.created_at, type: refund ? 'refund' : 'grant', place: t.terminal ?? '', zone: t.zone ?? '', points: t.amount, minutes: null,
      note: t.note ?? (refund ? `Reverses T-${t.ref}` : t.kind === 'fixed' ? 'Fixed amount reader' : null), by: t.staff ?? t.terminal ?? '', visitId: null, txId: t.id, stornoed: !refund && t.status === 'stornoed',
    });
  }
  for (const a of adjustments) events.push({ at: a.created_at, type: 'adjust', place: 'Admin', zone: '', points: a.delta, minutes: null, note: a.reason, by: a.staff ?? 'Admin', visitId: null, txId: null, stornoed: false });
  events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  // Totals. Everything that moved the balance is in transactions (including check-out pay and its reversal) or in adjustments.
  const sum = (rows: { amount?: number; delta?: number }[]) => rows.reduce((n, r) => n + (r.amount ?? r.delta ?? 0), 0);
  const ledger = (db.prepare('select coalesce(sum(amount),0) s from transactions where card_id=?').get(cardId) as { s: number }).s
    + (db.prepare('select coalesce(sum(delta),0) s from balance_adjustments where card_id=?').get(cardId) as { s: number }).s;
  const closed = visits.filter(v => v.status === 'closed');
  const notCounted = visits.filter(v => v.status === 'discarded' || v.status === 'expired');
  const open = visits.filter(v => v.status === 'open');
  const summary = {
    balance: card.balance,
    opening: card.balance - ledger,
    visits: visits.length, visitsPaid: closed.length, visitsCancelled: visits.filter(v => v.status === 'discarded').length, visitsExpired: visits.filter(v => v.status === 'expired').length, visitsOpen: open.length,
    minutesPaid: closed.reduce((n, v) => n + (v.minutes ?? 0), 0),
    minutesNotCounted: notCounted.reduce((n, v) => n + (v.minutes ?? 0), 0),
    minutesInsideNow: open.reduce((n, v) => n + (minutesOf(v) ?? 0), 0),
    pointsFromVisits: sum(txRows.filter(t => t.type === 'give' && t.kind === 'presence')),     // every check-out payout, including ones later cancelled
    pointsFromGrants: sum(txRows.filter(t => t.type === 'give' && t.kind !== 'presence')),
    pointsRefunded: sum(txRows.filter(t => t.type === 'storno')),                                // reversals of grants and of check-outs, negative
    pointsAdjusted: sum(adjustments.map(a => ({ delta: a.delta }))),
  };
  const byZone = new Map<string, { zone: string; visits: number; paid: number; minutes: number; points: number }>();
  for (const v of visits) {
    const name = v.zone_name ?? fallbackZone;
    const z = byZone.get(name) ?? { zone: name, visits: 0, paid: 0, minutes: 0, points: 0 };
    z.visits++;
    if (v.status === 'closed') { z.paid++; z.minutes += v.minutes ?? 0; z.points += v.points; }
    byZone.set(name, z);
  }
  return { card: { id: card.id, name: card.name, uid: card.uid, status: card.status, balance: card.balance, photoUrl: `/cards/${card.id}/photo` }, summary, byZone: [...byZone.values()].sort((a, b) => b.minutes - a.minutes), visits: visitJson, events, truncated };
}
