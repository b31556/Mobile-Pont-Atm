import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, makeOperator, auth } from './helpers.js';
import { DEFAULT_SETTINGS, defaultZone } from '../src/presence.js';
import { changeFor } from '../src/live.js';

const UID = '04:A2:3B:1C';

/** Two zones (Main area = the default, 8 points per 12 min, and Gym, 3 per 12 min) and a terminal of each kind in them. */
async function setup() {
  const ctx = await makeApp();
  const { app, db, adminToken } = ctx;
  const main = defaultZone(db);
  const gym = (await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym', settings: { ...DEFAULT_SETTINGS, pointsPerBlock: 3 } } })).json();
  const term = async (name: string, zoneId: string, direction: string) => {
    const t = makeTerminal(app, db, name);
    await app.inject({ method: 'PATCH', url: `/terminals/${t.terminalId}`, headers: auth(adminToken), payload: { mode: 'presence', zoneId, direction } });
    return t;
  };
  const mainToggle = await term('Main door', main.id, 'toggle'), mainIn = await term('Main in', main.id, 'in'), mainOut = await term('Main out', main.id, 'out');
  const gymToggle = await term('Gym door', gym.id, 'toggle'), gymIn = await term('Gym in', gym.id, 'in');
  const mk = async (name: string, uid: string, points = 46) => (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name, uid, points } })).json();
  const anna = await mk('Anna Kovács', UID);
  let n = 0;
  const tap = (t: { terminalToken: string }, uid = UID, key = `k${++n}`) => app.inject({ method: 'POST', url: '/presence/tap', headers: auth(t.terminalToken), payload: { cardUid: uid, idempotencyKey: key } });
  const backdate = (minutes: number, where = "status='open'") => db.prepare(`update presence_sessions set in_at=? where ${where}`).run(new Date(Date.now() - minutes * 60000).toISOString());
  const balance = (id = anna.id) => (db.prepare('select balance from cards where id=?').get(id) as { balance: number }).balance;
  const rows = (sql: string) => db.prepare(sql).all() as any[];
  const cancel = (t: { terminalToken: string } | string, id: number, expect?: string) =>
    app.inject({ method: 'POST', url: `/presence/sessions/${id}/cancel`, headers: auth(typeof t === 'string' ? t : t.terminalToken), payload: expect ? { expect } : {} });
  return { ...ctx, main, gym, mainToggle, mainIn, mainOut, gymToggle, gymIn, anna, mk, tap, backdate, balance, rows, cancel };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

describe('tapping in somewhere else while still inside', () => {
  it('a sign-in point of another zone cancels the old visit and signs in there', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(40);
    const res = (await c.tap(c.gymIn)).json();
    expect(res).toMatchObject({ action: 'in', zone: { name: 'Gym' }, discarded: { zone: 'Main area', minutes: 40 }, points: 0 });
    expect(c.rows('select zone_id, status, points, minutes from presence_sessions order by id')).toMatchObject([{ zone_id: c.main.id, status: 'discarded', points: 0, minutes: 40 }, { zone_id: c.gym.id, status: 'open' }]);
    expect(c.balance()).toBe(46);
    expect(c.rows("select * from transactions where kind='presence'")).toHaveLength(0);
  });

  it('so does a toggle point of another zone (it no longer signs out of the first zone)', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(40);
    expect((await c.tap(c.gymToggle)).json()).toMatchObject({ action: 'in', zone: { name: 'Gym' }, discarded: { zone: 'Main area' } });
    expect(c.balance()).toBe(46);
    // and from there a normal check-out in the Gym works
    c.backdate(36);
    expect((await c.tap(c.gymToggle)).json()).toMatchObject({ action: 'out', zone: { name: 'Gym' }, points: 9 });
  });

  it('is not held back by the re-tap lock-out of the first zone: it is a different place', async () => {
    const c = await setup();
    await c.tap(c.mainToggle);                                      // just now, inside the default 30 s lock-out
    expect((await c.tap(c.gymIn)).json()).toMatchObject({ action: 'in', zone: { name: 'Gym' }, discarded: { zone: 'Main area', minutes: 0 } });
  });

  it('a sign-in point of the SAME zone still just says already inside', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(40);
    expect((await c.tap(c.mainIn)).json()).toMatchObject({ action: 'already_in', zone: { name: 'Main area' } });
    expect(c.rows("select status from presence_sessions")).toEqual([{ status: 'open' }]);
  });

  it('a sign-out point of another zone still signs out, paid by the zone where the visit began', async () => {
    const c = await setup();
    await c.tap(c.gymToggle); c.backdate(36);
    expect((await c.tap(c.mainOut)).json()).toMatchObject({ action: 'out', points: 9, zone: { name: 'Gym' } });
  });

  it('a visit that was open longer than the longest stay is not "cancelled": it earned nothing anyway', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(13 * 60);
    const res = (await c.tap(c.gymIn)).json();
    expect(res).toMatchObject({ action: 'expired_in', zone: { name: 'Gym' } });
    expect(res.discarded).toBeUndefined();
  });

  it('the same tap sent twice (a lost reply) gives the same answer, the warning included, and changes nothing more', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(40);
    const first = (await c.tap(c.gymIn, UID, 'same')).json();
    const again = (await c.tap(c.gymIn, UID, 'same')).json();
    expect(again.discarded).toEqual(first.discarded);
    expect(again.sessionId).toBe(first.sessionId);
    expect(c.rows('select status from presence_sessions order by id')).toEqual([{ status: 'discarded' }, { status: 'open' }]);
  });

  it('other cards are not touched', async () => {
    const c = await setup();
    const bela = await c.mk('Béla', '04BBCCDD');
    await c.tap(c.mainToggle, '04BBCCDD'); await c.tap(c.mainToggle); c.backdate(40);
    await c.tap(c.gymIn);
    expect(c.rows('select card_id, status from presence_sessions order by id')).toMatchObject([{ card_id: bela.id, status: 'open' }, { status: 'discarded' }, { status: 'open' }]);
  });

  it('every answer names its visit', async () => {
    const c = await setup();
    const inn = (await c.tap(c.mainToggle)).json(); c.backdate(40);
    expect(inn.sessionId).toBe((c.rows('select id from presence_sessions')[0]).id);
    const out = (await c.tap(c.mainToggle)).json();
    expect(out.sessionId).toBe(inn.sessionId);
  });

  it('the display page next to the reader warns about it', async () => {
    const c = await setup();
    await c.tap(c.mainToggle); c.backdate(40);
    await c.tap(c.gymIn);
    const e = c.app.displayHub.last(c.gymIn.terminalId)!;
    expect(e).toMatchObject({ tone: 'warn', headline: 'Checked in', sound: 'refused' });
    expect(e.details[0]).toBe('Your visit at Main area was cancelled (40 min).');
    expect(e.details).toContain('No points for it.');
    expect(e.ref).toMatchObject({ type: 'visit' });
  });
});

describe('cancelling a check-in or a check-out', () => {
  it('a phone cancels the check-in it just made: the visit is discarded and the card can sign in again', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId;
    const r = await c.cancel(c.mainToggle, id, 'in');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ action: 'cancelled_in', points: 0, card: { name: 'Anna Kovács', balance: 46 }, zone: { name: 'Main area' } });
    expect(c.rows('select status, points from presence_sessions')).toEqual([{ status: 'discarded', points: 0 }]);
    expect((await c.tap(c.mainToggle)).json().action).toBe('in');
  });

  it('a phone cancels its check-out: the points come back off, a reversing row is written, and the visit is open again', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId; c.backdate(40);
    expect((await c.tap(c.mainToggle)).json()).toMatchObject({ action: 'out', points: 24 });
    expect(c.balance()).toBe(70);
    const r = await c.cancel(c.mainToggle, id, 'out');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ action: 'cancelled_out', points: 24, card: { balance: 46 } });
    expect(c.balance()).toBe(46);
    const tx = c.rows('select * from transactions order by id');
    expect(tx[0]).toMatchObject({ amount: 24, type: 'give', status: 'stornoed' });
    expect(tx[1]).toMatchObject({ amount: -24, type: 'storno', ref: tx[0].id, note: 'Check-out cancelled', balance_after: 46 });
    expect(c.rows('select status, minutes, points, tx_id, out_at, out_key from presence_sessions')).toEqual([{ status: 'open', minutes: null, points: 0, tx_id: null, out_at: null, out_key: null }]);
    // it is the same visit, so signing out again pays the same, and the 24 h allowance was not used up by the cancelled one
    expect((await c.tap(c.mainToggle)).json()).toMatchObject({ action: 'out', points: 24, today: { earned: 24 } });
  });

  it('cancelling a check-out that paid nothing just reopens the visit', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId; c.backdate(1);
    expect((await c.tap(c.mainToggle)).json()).toMatchObject({ action: 'out', points: 0 });
    expect((await c.cancel(c.mainToggle, id, 'out')).json()).toMatchObject({ action: 'cancelled_out', points: 0, card: { balance: 46 } });
    expect(c.rows('select * from transactions')).toHaveLength(0);
    expect(c.rows('select status from presence_sessions')).toEqual([{ status: 'open' }]);
  });

  it('only what happened at its own terminal: another phone is refused, an admin is not', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId;
    const other = await c.cancel(c.gymToggle, id, 'in');
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('other_terminal');
    expect(c.rows('select status from presence_sessions')).toEqual([{ status: 'open' }]);
    expect((await c.cancel(c.adminToken, id, 'in')).statusCode).toBe(200);
  });

  it('an operator who signed in on the phone can cancel too, but only there', async () => {
    const c = await setup();
    const op = await makeOperator(c.app, c.db);
    c.db.prepare("update terminals set mode='presence' where id=?").run(op.terminalId);
    const id = (await c.tap({ terminalToken: op.terminalToken })).json().sessionId;
    expect((await c.cancel(op.token, id, 'in')).statusCode).toBe(200);
  });

  it('cancelling a check-out twice (a double tap) cannot go on to discard the reopened visit', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId; c.backdate(40); await c.tap(c.mainToggle);
    expect((await c.cancel(c.mainToggle, id, 'out')).statusCode).toBe(200);
    const second = await c.cancel(c.mainToggle, id, 'out');
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('state_changed');
    expect(c.rows('select status from presence_sessions')).toEqual([{ status: 'open' }]);     // still open, not discarded
    expect((await c.cancel(c.mainToggle, id, 'in')).statusCode).toBe(200);                    // cancelling the CHECK-IN, now, is a deliberate thing
  });

  it('says what has gone wrong', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId;
    expect((await c.cancel(c.mainToggle, id, 'out')).json().code).toBe('state_changed');          // it is a check-in, not a check-out
    expect((await c.cancel(c.mainToggle, id)).statusCode).toBe(400);                              // must say what
    expect((await c.cancel(c.mainToggle, id, 'sideways')).statusCode).toBe(400);
    expect((await c.cancel(c.mainToggle, 9999, 'in')).statusCode).toBe(404);
    expect((await c.app.inject({ method: 'POST', url: `/presence/sessions/${id}/cancel`, payload: { expect: 'in' } })).statusCode).toBe(401);
    c.backdate(13 * 60); await c.tap(c.mainToggle);                                               // too long: expired, nothing was paid
    expect((await c.cancel(c.adminToken, id, 'out')).json().code).toBe('nothing_to_cancel');
    await c.tap(c.mainToggle); const id2 = (c.rows('select id from presence_sessions where status=\'open\''))[0].id;
    await c.cancel(c.adminToken, id2, 'in');
    expect((await c.cancel(c.adminToken, id2, 'in')).json().code).toBe('nothing_to_cancel');      // already discarded
  });

  it('a check-out cannot be cancelled once the card has checked in somewhere else', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId; c.backdate(40); await c.tap(c.mainToggle);
    await c.tap(c.gymIn);
    const r = await c.cancel(c.adminToken, id, 'out');
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('inside_elsewhere');
    expect(c.balance()).toBe(70);
  });

  it('a check-out cannot be cancelled when the card no longer has the points', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId; c.backdate(40); await c.tap(c.mainToggle);
    c.db.prepare('update cards set balance=5 where id=?').run(c.anna.id);          // spent
    const r = await c.cancel(c.adminToken, id, 'out');
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('would_go_negative');
    expect(c.rows('select status from presence_sessions')).toEqual([{ status: 'closed' }]);
    expect(c.balance()).toBe(5);
  });

  it('tells the display next to the reader', async () => {
    const c = await setup();
    const id = (await c.tap(c.mainToggle)).json().sessionId;
    await c.cancel(c.mainToggle, id, 'in');
    expect(c.app.displayHub.last(c.mainToggle.terminalId)).toMatchObject({ headline: 'Cancelled', tone: 'neutral' });
  });
});

describe('sign out everyone / discard everyone in a zone', () => {
  const closeAll = (c: Ctx, zoneId: string, award: unknown, token = c.adminToken) => c.app.inject({ method: 'POST', url: `/zones/${zoneId}/close-all`, headers: auth(token), payload: { award } });

  async function crowd(c: Ctx) {
    const kids = [await c.mk('K1', '0A0A0A01', 0), await c.mk('K2', '0A0A0A02', 0), await c.mk('K3', '0A0A0A03', 0)];
    for (const k of kids) await c.tap(c.mainToggle, k.uid);
    const g = await c.mk('Gymmer', '0B0B0B01', 0);
    await c.tap(c.gymToggle, g.uid);
    c.backdate(36, `zone_id='${c.main.id}'`); c.backdate(36, `zone_id='${c.gym.id}'`);
    return { kids, g };
  }

  it('signs out everyone in the zone and pays each by the zone’s rules, leaving other zones alone', async () => {
    const c = await setup();
    const { kids, g } = await crowd(c);
    const r = await closeAll(c, c.main.id, true);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, closed: 3, points: 72, overdue: 0 });      // 36 min = 3 blocks of 8, three people
    for (const k of kids) expect(c.balance(k.id)).toBe(24);
    expect(c.balance(g.id)).toBe(0);
    expect(c.rows(`select status, count(*) n from presence_sessions group by status order by status`)).toEqual([{ status: 'closed', n: 3 }, { status: 'open', n: 1 }]);
    expect(c.rows("select count(*) n from transactions where kind='presence' and type='give'")[0].n).toBe(3);
  });

  it('discards everyone in the zone: no points at all', async () => {
    const c = await setup();
    const { kids } = await crowd(c);
    expect((await closeAll(c, c.main.id, false)).json()).toEqual({ ok: true, closed: 3, points: 0, overdue: 0 });
    for (const k of kids) expect(c.balance(k.id)).toBe(0);
    expect(c.rows('select status from presence_sessions order by id')).toEqual([{ status: 'discarded' }, { status: 'discarded' }, { status: 'discarded' }, { status: 'open' }]);
    expect(c.rows('select * from transactions')).toHaveLength(0);
  });

  it('a visit longer than the longest stay earns nothing when signed out, and is counted as overdue', async () => {
    const c = await setup();
    const { kids } = await crowd(c);
    c.backdate(14 * 60, `card_id='${kids[0].id}'`);
    expect((await closeAll(c, c.main.id, true)).json()).toEqual({ ok: true, closed: 3, points: 48, overdue: 1 });
    expect(c.balance(kids[0].id)).toBe(0);
    expect(c.rows(`select status from presence_sessions where card_id='${kids[0].id}'`)).toEqual([{ status: 'expired' }]);
  });

  it('the default zone also takes visits from before zones existed (no zone recorded)', async () => {
    const c = await setup();
    c.db.prepare("insert into presence_sessions(card_id,zone_id,in_at,status) values(?,NULL,?,'open')").run(c.anna.id, new Date(Date.now() - 36 * 60000).toISOString());
    expect((await closeAll(c, c.main.id, true)).json()).toMatchObject({ closed: 1, points: 24 });
    expect(c.balance()).toBe(70);
  });

  it('an empty zone, an unknown zone, a non-admin and a missing choice', async () => {
    const c = await setup();
    expect((await closeAll(c, c.gym.id, true)).json()).toEqual({ ok: true, closed: 0, points: 0, overdue: 0 });
    expect((await closeAll(c, 'nope', true)).statusCode).toBe(404);
    expect((await closeAll(c, c.main.id, true, c.mainToggle.terminalToken)).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `/zones/${c.main.id}/close-all`, payload: { award: true } })).statusCode).toBe(401);
    await c.tap(c.mainToggle); c.backdate(36);
    expect((await closeAll(c, c.main.id, undefined)).json()).toMatchObject({ closed: 1, points: 0 });   // anything but true is "discard", never "pay"
  });

  it('wakes the other admin pages for points, cards and the check-in list', () => {
    expect(changeFor('POST', '/zones/abc/close-all', 200)?.topics.sort()).toEqual(['cards', 'presence', 'transactions', 'zones']);
    expect(changeFor('POST', '/presence/sessions/3/cancel', 200)?.topics.sort()).toEqual(['cards', 'presence', 'transactions']);
  });
});
