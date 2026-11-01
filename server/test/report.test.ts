import { describe, it, expect } from 'vitest';
import { makeApp, makeReader, makeTerminal, auth, makeOperator } from './helpers.js';
import { DEFAULT_SETTINGS, defaultZone } from '../src/presence.js';

const UID = '04:A2:3B:1C';

/** A card that has been through everything: grants, a refund, check-ins and outs in two zones, a move, a cancelled check-out and an adjustment. */
async function life() {
  const ctx = await makeApp();
  const { app, db, adminToken } = ctx;
  const main = defaultZone(db);
  const zoneSettings = { ...DEFAULT_SETTINGS, cooldownSeconds: 0 };
  await app.inject({ method: 'PUT', url: `/zones/${main.id}`, headers: auth(adminToken), payload: { settings: zoneSettings } });
  const gym = (await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym', settings: { ...zoneSettings, pointsPerBlock: 3 } } })).json();
  const anna = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Anna Kovács', uid: UID, points: 46 } })).json();
  const bar = makeTerminal(app, db, 'Bar 2');
  const gift = await makeReader(app, adminToken, { name: 'Gift reader' });
  const door = makeTerminal(app, db, 'Main door'), gymDoor = makeTerminal(app, db, 'Gym door');
  for (const [t, zoneId] of [[door, main.id], [gymDoor, gym.id]] as const) await app.inject({ method: 'PATCH', url: `/terminals/${t.terminalId}`, headers: auth(adminToken), payload: { mode: 'presence', zoneId, direction: 'toggle' } });
  let n = 0;
  const presence = (t: { terminalToken: string }) => app.inject({ method: 'POST', url: '/presence/tap', headers: auth(t.terminalToken), payload: { cardUid: UID, idempotencyKey: `p${++n}` } });
  const backdate = (min: number) => db.prepare("update presence_sessions set in_at=? where status='open'").run(new Date(Date.now() - min * 60000).toISOString());
  const report = async () => (await app.inject({ method: 'GET', url: `/cards/${anna.id}/report`, headers: auth(adminToken) })).json();

  const charge = (await app.inject({ method: 'POST', url: '/charges', headers: auth(bar.terminalToken), payload: { cardUid: UID, amount: 8, idempotencyKey: 'c1' } })).json();   // +8 at Bar 2
  await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(gift.terminalToken), payload: { cardUid: UID, idempotencyKey: 'f1' } });                                 // +10 at the gift reader
  await app.inject({ method: 'POST', url: `/transactions/${charge.transaction.id}/storno`, headers: auth(adminToken) });                                                       // -8 refund
  await presence(door); backdate(40); await presence(door);                                                                                                                        // Main area, 40 min: +24
  await presence(gymDoor); backdate(30); await presence(door);                                                                                                                     // in at the Gym, moved to Main area: Gym visit cancelled
  backdate(36); const out2 = (await presence(door)).json();                                                                                                                         // Main area, 36 min: +24
  await app.inject({ method: 'POST', url: `/presence/sessions/${out2.sessionId}/cancel`, headers: auth(adminToken), payload: { expect: 'out' } });                              // check-out cancelled: -24, visit open again
  await app.inject({ method: 'POST', url: `/cards/${anna.id}/adjust`, headers: auth(adminToken), payload: { delta: 5, reason: 'Prize' } });                                     // +5 by the admin
  return { ...ctx, anna, main, gym, report, out2 };
}

describe('GET /cards/:id/report', () => {
  it('lists every visit with its zone, terminals, times, minutes and points', async () => {
    const c = await life();
    const r = await c.report();
    expect(r.card).toMatchObject({ name: 'Anna Kovács', uid: UID, balance: 46 + 10 + 24 + 5 });
    const v = (status: string) => r.visits.filter((x: any) => x.status === status);
    expect(r.visits).toHaveLength(3);
    expect(v('closed')).toHaveLength(1);
    expect(v('closed')[0]).toMatchObject({ zone: 'Main area', inPlace: 'Main door', outPlace: 'Main door', minutes: 40, points: 24 });
    expect(v('discarded')).toHaveLength(1);
    expect(v('discarded')[0]).toMatchObject({ zone: 'Gym', inPlace: 'Gym door', outPlace: 'Main door', minutes: 30, points: 0 });
    expect(v('open')).toHaveLength(1);                                           // the reopened one
    expect(v('open')[0]).toMatchObject({ zone: 'Main area', minutes: expect.any(Number) });
  });

  it('lists every event with what, where, who and how many points, newest first', async () => {
    const c = await life();
    const { events } = await c.report();
    const types = events.map((e: any) => e.type);
    expect(types.filter((t: string) => t === 'checkin')).toHaveLength(3);
    for (const t of ['checkout', 'discard', 'grant', 'refund', 'adjust']) expect(types).toContain(t);
    const times = events.map((e: any) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    const find = (type: string, f: (e: any) => boolean = () => true) => events.find((e: any) => e.type === type && f(e));
    expect(find('grant', e => e.place === 'Bar 2')).toMatchObject({ points: 8, by: 'Bar 2', stornoed: true });
    expect(find('grant', e => e.place === 'Gift reader')).toMatchObject({ points: 10, note: 'Fixed amount reader' });
    expect(find('refund', e => e.points === -8)).toMatchObject({ note: expect.stringContaining('Reverses T-') });
    expect(find('discard')).toMatchObject({ zone: 'Gym', minutes: 30, points: 0, place: 'Main door' });
    expect(find('adjust')).toMatchObject({ points: 5, note: 'Prize', by: 'Admin' });
    expect(find('checkout', e => !e.stornoed)).toMatchObject({ zone: 'Main area', points: 24, minutes: 40, place: 'Main door' });
    expect(find('checkout', e => e.stornoed)).toMatchObject({ points: 24, note: 'Check-out cancelled' });
    expect(find('refund', e => e.points === -24)).toMatchObject({ note: 'Check-out cancelled' });
  });

  it('the totals add up to the balance', async () => {
    const c = await life();
    const { summary, card, byZone } = await c.report();
    expect(summary.opening).toBe(46);
    expect(summary.pointsFromGrants).toBe(18);                      // +8 and +10
    expect(summary.pointsFromVisits).toBe(48);                      // two check-outs of 24, one of them later cancelled
    expect(summary.pointsRefunded).toBe(-32);                       // the refund of -8 and the cancelled check-out -24
    expect(summary.pointsAdjusted).toBe(5);
    expect(summary.opening + summary.pointsFromGrants + summary.pointsFromVisits + summary.pointsRefunded + summary.pointsAdjusted).toBe(card.balance);
    expect(summary).toMatchObject({ visits: 3, visitsPaid: 1, visitsCancelled: 1, visitsOpen: 1, minutesPaid: 40, minutesNotCounted: 30 });
    expect(byZone).toEqual([{ zone: 'Main area', visits: 2, paid: 1, minutes: 40, points: 24 }, { zone: 'Gym', visits: 1, paid: 0, minutes: 0, points: 0 }]);
  });

  it('names a person when one was signed in, and the terminal otherwise', async () => {
    const c = await makeApp();
    const op = await makeOperator(c.app, c.db, 'eszter@pont.example', 'Bar 3');
    const card = (await c.app.inject({ method: 'POST', url: '/cards', headers: auth(c.adminToken), payload: { name: 'Béla', uid: '04BBCCDD' } })).json();
    await c.app.inject({ method: 'POST', url: '/charges', headers: auth(op.token), payload: { cardUid: '04BBCCDD', amount: 5, idempotencyKey: 'x1' } });
    await c.app.inject({ method: 'POST', url: '/charges', headers: auth(op.terminalToken), payload: { cardUid: '04BBCCDD', amount: 3, idempotencyKey: 'x2' } });
    const { events } = (await c.app.inject({ method: 'GET', url: `/cards/${card.id}/report`, headers: auth(c.adminToken) })).json();
    expect(events.map((e: any) => [e.points, e.by])).toEqual([[3, 'Bar 3'], [5, 'Eszter']]);
  });

  it('an empty card has an empty report, and only an admin may read one', async () => {
    const c = await makeApp();
    const card = (await c.app.inject({ method: 'POST', url: '/cards', headers: auth(c.adminToken), payload: { name: 'New', uid: '04AABBCC', points: 7 } })).json();
    const r = (await c.app.inject({ method: 'GET', url: `/cards/${card.id}/report`, headers: auth(c.adminToken) })).json();
    expect(r).toMatchObject({ events: [], visits: [], byZone: [], truncated: false, summary: { balance: 7, opening: 7, visits: 0, minutesPaid: 0 } });
    const phone = makeTerminal(c.app, c.db);
    expect((await c.app.inject({ method: 'GET', url: `/cards/${card.id}/report`, headers: auth(phone.terminalToken) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'GET', url: `/cards/${card.id}/report` })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'GET', url: '/cards/nope/report', headers: auth(c.adminToken) })).statusCode).toBe(404);
  });

  it('is never cached', async () => {
    const c = await life();
    const res = await c.app.inject({ method: 'GET', url: `/cards/${c.anna.id}/report`, headers: auth(c.adminToken) });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
