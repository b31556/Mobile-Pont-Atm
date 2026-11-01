import type { Db } from './db.js';
import { stamp } from './clock.js';
import type { CardRow } from './routes/cards.js';

/** A refusal with the HTTP status and code to answer with. */
export class Refusal extends Error {
  constructor(public status: number, public code: string, message: string, public extra: object = {}) { super(message); }
}

export interface TxRow {
  id: number; card_id: string; amount: number; type: 'give' | 'storno'; status: 'ok' | 'stornoed';
  ref: number | null; terminal_id: string | null; operator_id: string | null;
  idempotency_key: string | null; created_at: string; balance_after: number;
}

/** Who is cancelling: an operator (a phone, or a person signed in on one) may only undo what was done on its own terminal, an admin anything. */
export interface Canceller { id: string; role: string; terminalId?: string; viaTerminal?: boolean }

/** Reverses a charge: takes the points back, marks the original stornoed and adds a reversing row. Throws a Refusal if it cannot. */
export function stornoTransaction(db: Db, id: number, user: Canceller): { tx: TxRow; card: CardRow } {
  return db.transaction(() => {
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
      values(?,?,'storno','ok',?,?,?,?,?)`).run(card.id, -orig.amount, id, user.terminalId ?? orig.terminal_id, user.viaTerminal ? null : user.id, stamp().toISOString(), after).lastInsertRowid;
    return { tx: db.prepare('select * from transactions where id=?').get(rid) as TxRow, card: { ...card, balance: after } as CardRow };
  })();
}
