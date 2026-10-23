import { describe, it, expect } from 'vitest';
import { makeApp, makeReader, makeTerminal, auth } from './helpers.js';

const UID = '04:A2:3B:1C';

async function setup(fixed: object = {}) {
  const ctx = await makeApp();
  const reader = await makeReader(ctx.app, ctx.adminToken, { name: 'Gift reader' });
  const configure = (settings: object, id = reader.terminalId) =>
    ctx.app.inject({ method: 'PATCH', url: `/terminals/${id}`, headers: auth(ctx.adminToken), payload: { fixed: { amount: 10, cooldownSeconds: 0, maxUses24h: null, maxPoints24h: null, maxUsesTotal: null, ...settings } } });
  await configure(fixed);
  const card = async (name: string, uid: string, points = 0) =>
    (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name, uid, points } })).json();
  const anna = await card('Anna Kovács', UID, 46);
  let n = 0;
  const tap = (token = reader.terminalToken, uid = UID, key = `k${++n}`) =>
    ctx.app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(token), payload: { cardUid: uid, idempotencyKey: key } });
  const balance = (id = anna.id) => (ctx.db.prepare('select balance from cards where id=?').get(id) as { balance: number }).balance;
  const count = (sql: string) => (ctx.db.prepare(sql).get() as { c: number }).c;
  /** Moves every grant [hours] hours into the past. */
  const age = (hours: number) => ctx.db.prepare("update transactions set created_at=? where kind='fixed'").run(new Date(Date.now() - hours * 3600 * 1000).toISOString());
  return { ...ctx, reader, configure, card, anna, tap, balance, count, age };
}

describe('a fixed-amount reader', () => {
  it('gives the amount, credits the card and answers with the balance after', async () => {
    const { tap, balance, db, anna, reader } = await setup({ amount: 10 });
    const res = await tap();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'granted', points: 10, balanceBefore: 46, card: { id: anna.id, name: 'Anna Kovács', balance: 56, photoUrl: `/cards/${anna.id}/photo` } });
    expect(balance()).toBe(56);
    const t = db.prepare("select * from transactions where kind='fixed'").get() as any;
    expect(t).toMatchObject({ card_id: anna.id, amount: 10, type: 'give', status: 'ok', terminal_id: reader.terminalId, operator_id: null, balance_after: 56 });
  });

  it('a repeated tap key gives the points once and answers the same', async () => {
    const { tap, balance, count } = await setup();
    await tap(undefined, UID, 'same');
    const again = await tap(undefined, UID, 'same');
    expect(again.json()).toMatchObject({ action: 'granted', points: 10, balanceBefore: 46, card: { balance: 56 } });
    expect(balance()).toBe(56);
    expect(count("select count(*) c from transactions where kind='fixed'")).toBe(1);
  });

  it('the amount is whatever the reader is set to, and a change applies to the next tap', async () => {
    const { tap, configure, balance } = await setup({ amount: 10 });
    await tap(); await configure({ amount: 3 }); await tap();
    expect(balance()).toBe(46 + 10 + 3);
  });

  it('says how long to wait when tapped again too soon, and changes nothing', async () => {
    const { tap, configure, balance, age } = await setup({ cooldownSeconds: 60 });
    await tap();
    const res = await tap();
    expect(res.json()).toMatchObject({ action: 'cooldown', points: 0, card: { balance: 56 } });
    expect(res.json().retryInSeconds).toBeGreaterThan(55); expect(res.json().retryInSeconds).toBeLessThanOrEqual(60);
    expect(balance()).toBe(56);
    age(1 / 60 * 2);                      // two minutes ago
    expect((await tap()).json().action).toBe('granted');
    void configure;
  });

  it('stops after the daily number of taps, says when the oldest frees up, and a storno gives one back', async () => {
    const { app, adminToken, tap, db, age } = await setup({ maxUses24h: 2 });
    await tap(); await tap();
    age(20);
    const third = await tap();
    expect(third.json()).toMatchObject({ action: 'limit_uses', points: 0, limits: { uses24h: 2, maxUses24h: 2 } });
    expect(third.json().retryInSeconds).toBeGreaterThan(3.9 * 3600); expect(third.json().retryInSeconds).toBeLessThanOrEqual(4 * 3600);
    const id = (db.prepare("select id from transactions where kind='fixed' order by id limit 1").get() as { id: number }).id;
    expect((await app.inject({ method: 'POST', url: `/transactions/${id}/storno`, headers: auth(adminToken) })).statusCode).toBe(200);
    expect((await tap()).json().action).toBe('granted');
  });

  it('stops when one more grant would pass the daily points limit', async () => {
    const { tap, balance } = await setup({ amount: 10, maxPoints24h: 25 });
    await tap(); await tap();
    expect((await tap()).json()).toMatchObject({ action: 'limit_points', points: 0 });
    expect(balance()).toBe(66);
  });

  it('the daily limits only count the last 24 hours', async () => {
    const { tap, age } = await setup({ maxUses24h: 1, maxPoints24h: 10 });
    await tap(); expect((await tap()).json().action).toBe('limit_uses');
    age(25);
    expect((await tap()).json().action).toBe('granted');
  });

  it('the lifetime limit never lifts', async () => {
    const { tap, age } = await setup({ maxUsesTotal: 2 });
    await tap(); await tap();
    age(100);
    expect((await tap()).json()).toMatchObject({ action: 'limit_total', retryInSeconds: null });
  });

  it('limits are per card and per reader', async () => {
    const { app, adminToken, tap, card, reader } = await setup({ maxUses24h: 1 });
    await card('Bence', '04:7F:91:E2');
    await tap(); expect((await tap()).json().action).toBe('limit_uses');
    expect((await tap(reader.terminalToken, '04:7F:91:E2')).json().action).toBe('granted');       // another card
    const other = await makeReader(app, adminToken, { name: 'Second reader' });
    await app.inject({ method: 'PATCH', url: `/terminals/${other.terminalId}`, headers: auth(adminToken), payload: { fixed: { amount: 10, cooldownSeconds: 0, maxUses24h: 1, maxPoints24h: null, maxUsesTotal: null } } });
    expect((await tap(other.terminalToken)).json().action).toBe('granted');                        // same card, other reader
  });

  it('two taps at the same instant give points once when there is a wait between taps', async () => {
    const { tap, balance, count } = await setup({ cooldownSeconds: 60 });
    const [a, b] = await Promise.all([tap(), tap()]);
    expect([a.json().action, b.json().action].sort()).toEqual(['cooldown', 'granted']);
    expect(balance()).toBe(56);
    expect(count("select count(*) c from transactions where kind='fixed'")).toBe(1);
  });

  it('a grant can be stornoed in admin and the points come back off', async () => {
    const { app, adminToken, tap, balance, db } = await setup();
    await tap();
    const id = (db.prepare("select id from transactions where kind='fixed'").get() as { id: number }).id;
    const res = await app.inject({ method: 'POST', url: `/transactions/${id}/storno`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(balance()).toBe(46);
  });
});

describe('refusals', () => {
  it('a blocked card gets nothing', async () => {
    const { app, adminToken, anna, tap, balance, count } = await setup();
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    const res = await tap();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'card_blocked', card: { name: 'Anna Kovács' } });
    expect(balance()).toBe(46); expect(count("select count(*) c from transactions where kind='fixed'")).toBe(0);
  });

  it('an unregistered card is refused and suggested to admins automatically', async () => {
    const { app, adminToken, tap } = await setup();
    const res = await tap(undefined, '04:EE:00:77');
    expect(res.statusCode).toBe(404); expect(res.json().code).toBe('unknown_card');
    const list = (await app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(adminToken) })).json();
    expect(list.map((r: { uid: string }) => r.uid)).toEqual(['04:EE:00:77']);
  });

  it('a reader that is in check-in mode, or a phone, refuses fixed taps', async () => {
    const { app, db, adminToken, reader, tap } = await setup();
    await app.inject({ method: 'PATCH', url: `/terminals/${reader.terminalId}`, headers: auth(adminToken), payload: { mode: 'presence' } });
    const res = await tap();
    expect(res.statusCode).toBe(409); expect(res.json().code).toBe('wrong_mode');
    expect((await tap(makeTerminal(app, db, 'Phone').terminalToken)).statusCode).toBe(409);
  });

  it('a missing key is a 400, and a revoked reader is a 401', async () => {
    const { app, adminToken, reader, tap } = await setup();
    expect((await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(reader.terminalToken), payload: { cardUid: UID } })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect((await tap()).statusCode).toBe(401);
  });

  it('admins cannot tap', async () => {
    const { adminToken, tap } = await setup();
    expect((await tap(adminToken)).statusCode).toBe(403);
  });
});

describe('check-in taps from a reader work like from a phone', () => {
  it('a reader in check-in mode signs a card in and answers with the balance', async () => {
    const { app, adminToken } = await makeApp();
    const reader = await makeReader(app, adminToken, { mode: 'presence' });
    const anna = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Anna', uid: UID, points: 46 } })).json();
    const res = await app.inject({ method: 'POST', url: '/presence/tap', headers: auth(reader.terminalToken), payload: { cardUid: UID, idempotencyKey: 'a' } });
    expect(res.json()).toMatchObject({ action: 'in', card: { id: anna.id, balance: 46 }, zone: { name: 'Main area' } });
  });
});
