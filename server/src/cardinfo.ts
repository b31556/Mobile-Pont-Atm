import type { Db } from './db.js';

/** One line of a card's history, as the apps show it. [amount] is signed. [place] is the terminal or zone ("" for an admin adjustment). */
export interface HistoryItem {
  at: string;
  kind: 'atm' | 'fixed' | 'presence' | 'storno' | 'adjust';
  amount: number;
  place: string;
  note: string | null;
  stornoed: boolean;
}

/** The newest [limit] things that happened to a card: points given at terminals and readers, check-out pay, refunds and admin adjustments. */
export function cardHistory(db: Db, cardId: string, limit: number): HistoryItem[] {
  const rows = db.prepare(`select t.created_at, t.amount, t.type, t.status, t.kind, t.note, tm.name terminal, z.name zone
      from transactions t left join terminals tm on tm.id=t.terminal_id left join zones z on z.id=t.zone_id
      where t.card_id=? order by t.id desc limit ?`).all(cardId, limit) as
    { created_at: string; amount: number; type: string; status: string; kind: string | null; note: string | null; terminal: string | null; zone: string | null }[];
  const items: HistoryItem[] = rows.map(r => {
    const kind: HistoryItem['kind'] = r.type === 'storno' ? 'storno' : r.kind === 'fixed' || r.kind === 'presence' ? r.kind : 'atm';
    return {
      at: r.created_at, kind, amount: r.amount,
      place: (kind === 'presence' ? r.zone ?? r.terminal : r.terminal ?? r.zone) ?? '',   // a check-out is named for the zone, the rest for the terminal
      note: r.note ?? null, stornoed: r.type === 'give' && r.status === 'stornoed',
    };
  });
  const adjustments = db.prepare('select created_at, delta, reason from balance_adjustments where card_id=? order by created_at desc limit ?').all(cardId, limit) as
    { created_at: string; delta: number; reason: string | null }[];
  for (const a of adjustments) items.push({ at: a.created_at, kind: 'adjust', amount: a.delta, place: '', note: a.reason ?? null, stornoed: false });
  return items.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0)).slice(0, limit);
}
