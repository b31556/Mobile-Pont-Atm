/** What a reader's display page shows. Events live in memory only. */

export type Tone = 'good' | 'neutral' | 'warn' | 'refused';
export type Sound = 'success' | 'in' | 'out' | 'refused';

export interface DisplayEvent {
  seq: number;
  at: string;
  tone: Tone;
  headline: string;
  details: string[];
  balance: number | null;        // null = the page shows no balance
  card: { id: string; name: string } | null;
  sound: Sound | null;
}
export type NewEvent = Omit<DisplayEvent, 'seq' | 'at'>;

const KEEP = 20;
const HOUR_MS = 3600 * 1000;

export class DisplayHub {
  private seq = 0;
  private subs = new Map<string, Set<(e: DisplayEvent) => void>>();
  private events = new Map<string, { event: DisplayEvent; atMs: number }[]>();
  constructor(private now: () => number = Date.now) {}

  publish(terminalId: string, e: NewEvent): DisplayEvent {
    const event: DisplayEvent = { ...e, seq: ++this.seq, at: new Date(this.now()).toISOString() };
    const list = this.events.get(terminalId) ?? [];
    list.push({ event, atMs: this.now() });
    while (list.length > KEEP) list.shift();
    this.events.set(terminalId, list);
    for (const fn of [...(this.subs.get(terminalId) ?? [])]) { try { fn(event); } catch { /* a closed connection must not stop the others */ } }
    return event;
  }

  subscribe(terminalId: string, fn: (e: DisplayEvent) => void): () => void {
    const set = this.subs.get(terminalId) ?? new Set();
    set.add(fn);
    this.subs.set(terminalId, set);
    return () => { set.delete(fn); if (!set.size) this.subs.delete(terminalId); };
  }

  count(terminalId: string): number { return this.subs.get(terminalId)?.size ?? 0; }

  last(terminalId: string): DisplayEvent | null {
    const list = this.events.get(terminalId);
    return list && list.length ? list[list.length - 1].event : null;
  }

  /** Cards that tapped on this terminal in the last hour: the only photos its display page may show. */
  recentCardIds(terminalId: string): Set<string> {
    const since = this.now() - HOUR_MS;
    const ids = new Set<string>();
    for (const { event, atMs } of this.events.get(terminalId) ?? []) if (event.card && atMs >= since) ids.add(event.card.id);
    return ids;
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** "40 seconds", "5 minutes", "4 hours". */
function wait(seconds: number): string {
  if (seconds < 120) return plural(Math.max(1, Math.round(seconds)), 'second');
  if (seconds < 7200) return plural(Math.round(seconds / 60), 'minute');
  return plural(Math.round(seconds / 3600), 'hour');
}

const duration = (min: number) => (min < 60 ? `${min} min` : min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`);
const clock = (iso: unknown) => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

interface Answer { status: number; body: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Turns what a tap endpoint answered into what the display page shows, or null if it means nothing to a person
 * standing there. [mode] says which endpoint answered: the same word ("cooldown") reads differently in each.
 */
export function eventFor(r: Answer, mode: 'fixed' | 'presence' | 'atm'): NewEvent | null {
  const b = r.body ?? {};
  if (r.status === 404 && b.code === 'unknown_card') return { tone: 'refused', headline: 'Card not registered', details: ['An admin has been told.'], balance: null, card: null, sound: 'refused' };
  if (r.status === 403 && b.code === 'card_blocked') {
    const id = /^\/cards\/([^/]+)\/photo$/.exec(b.card?.photoUrl ?? '')?.[1];
    return { tone: 'refused', headline: 'Card is blocked', details: ['Ask an admin to unblock it.'], balance: null, card: id ? { id, name: String(b.card?.name ?? '') } : null, sound: 'refused' };
  }
  if (r.status !== 200) return null;
  const c = b.card;
  if (!c?.id) return null;
  const card = { id: String(c.id), name: String(c.name ?? '') };
  const balance = typeof c.balance === 'number' ? c.balance : null;
  const zone = b.zone?.name ? `Zone: ${b.zone.name}` : null;
  const lines = (...l: (string | null | false)[]) => l.filter((x): x is string => !!x);

  if (mode === 'atm') {
    if (!b.transaction) return null;
    return { tone: 'good', headline: `+${plural(b.transaction.amount, 'point')}`, details: [], balance, card, sound: 'success' };
  }

  if (mode === 'fixed') {
    switch (b.action) {
      case 'granted': return { tone: 'good', headline: `+${plural(b.points, 'point')}`, details: [], balance, card, sound: 'success' };
      case 'cooldown': return { tone: 'neutral', headline: 'Too soon', details: [`Try again in ${wait(b.retryInSeconds ?? 1)}.`], balance, card, sound: 'refused' };
      case 'limit_uses': return { tone: 'warn', headline: 'Limit reached', details: lines('Taps per day used up.', b.retryInSeconds ? `Try again in ${wait(b.retryInSeconds)}.` : null), balance, card, sound: 'refused' };
      case 'limit_points': return { tone: 'warn', headline: 'Limit reached', details: lines('Daily points limit.', b.retryInSeconds ? `Try again in ${wait(b.retryInSeconds)}.` : null), balance, card, sound: 'refused' };
      case 'limit_total': return { tone: 'warn', headline: 'No more for this card', details: [], balance, card, sound: 'refused' };
      default: return null;
    }
  }

  switch (b.action) {   // check-in mode: a balance only after signing out
    case 'in': return { tone: 'good', headline: 'Checked in', details: lines(zone, `Since ${clock(b.inAt)}`), balance: null, card, sound: 'in' };
    case 'out': return { tone: 'good', headline: 'Checked out', details: lines(`${duration(b.minutes ?? 0)} inside`, b.points > 0 ? `+${plural(b.points, 'point')}` : 'No points this time', b.cappedBy === 'visit' ? 'Visit limit reached.' : b.cappedBy === '24h' ? 'Daily limit reached.' : null, zone), balance, card, sound: 'out' };
    case 'cooldown': return { tone: 'neutral', headline: 'Already checked in', details: ['You were just checked in.'], balance: null, card, sound: 'refused' };
    case 'already_in': return { tone: 'neutral', headline: 'Already checked in', details: lines(`Since ${clock(b.inAt)}`, zone, 'Use a sign-out point to check out.'), balance: null, card, sound: 'refused' };
    case 'not_in': return { tone: 'warn', headline: 'Not checked in', details: ['Check in at a sign-in point first.'], balance: null, card, sound: 'refused' };
    case 'expired_out': return { tone: 'warn', headline: 'Checked out', details: ['Your last visit wasn’t signed out in time, so it earned no points.'], balance, card, sound: 'out' };
    case 'expired_in': return { tone: 'warn', headline: 'Checked in', details: lines(`Since ${clock(b.inAt)}`, zone, 'Your last visit wasn’t signed out, so it earned no points.'), balance: null, card, sound: 'in' };
    default: return null;
  }
}
