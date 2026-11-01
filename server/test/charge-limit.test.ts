import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, makeReader, auth } from './helpers.js';

async function setup() {
  const ctx = await makeApp();
  const t = makeTerminal(ctx.app, ctx.db, 'Bar 1');
  const card = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna', uid: '04A23B1C', points: 0 } })).json();
  let n = 0;
  const charge = (amount: number, token = t.terminalToken, key = `k${++n}`, uid = '04:A2:3B:1C') =>
    ctx.app.inject({ method: 'POST', url: '/charges', headers: auth(token), payload: { cardUid: uid, amount, idempotencyKey: key } });
  const setLimit = (terminalId: string, chargeLimitHour: unknown) =>
    ctx.app.inject({ method: 'PATCH', url: `/terminals/${terminalId}`, headers: auth(ctx.adminToken), payload: { chargeLimitHour } });
  const balance = () => (ctx.db.prepare('select balance from cards where id=?').get(card.id) as { balance: number }).balance;
  return { ...ctx, t, card, charge, setLimit, balance };
}

describe('hourly points limit per phone', () => {
  it('a new terminal starts at 5000 points per hour', async () => {
    const { db, t } = await setup();
    expect((db.prepare('select charge_limit_hour l from terminals where id=?').get(t.terminalId) as { l: number }).l).toBe(5000);
  });

  it('a phone token alone cannot give more than the limit in an hour', async () => {
    const { charge, balance } = await setup();
    expect((await charge(3000)).statusCode).toBe(200);
    expect((await charge(2000)).statusCode).toBe(200);          // exactly 5000: allowed
    const over = await charge(1);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'terminal_limit' });
    expect(over.json().error).toMatch(/5000 points per hour/);
    expect(over.json().retryInSeconds).toBeGreaterThan(3500);
    expect(balance()).toBe(5000);
  });

  it('a refused charge writes nothing', async () => {
    const { charge, db } = await setup();
    await charge(5000);
    await charge(10);
    expect((db.prepare('select count(*) c from transactions').get() as { c: number }).c).toBe(1);
  });

  it('a retried charge that was already counted is answered again, not refused', async () => {
    const { charge, balance } = await setup();
    const first = await charge(5000, undefined, 'same');
    const again = await charge(5000, undefined, 'same');
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json().transaction.id).toBe(first.json().transaction.id);
    expect(balance()).toBe(5000);
  });

  it('a storno gives the allowance back', async () => {
    const { app, t, charge } = await setup();
    const tx = (await charge(5000)).json().transaction.id;
    expect((await charge(1)).statusCode).toBe(429);
    expect((await app.inject({ method: 'POST', url: `/transactions/${tx}/storno`, headers: auth(t.terminalToken) })).statusCode).toBe(200);
    expect((await charge(5000)).statusCode).toBe(200);
  });

  it('charges older than an hour no longer count', async () => {
    const { db, charge } = await setup();
    await charge(5000);
    db.prepare('update transactions set created_at=?').run(new Date(Date.now() - 61 * 60 * 1000).toISOString());
    expect((await charge(5000)).statusCode).toBe(200);
  });

  it('another phone is not affected', async () => {
    const { app, db, charge } = await setup();
    await charge(5000);
    const other = makeTerminal(app, db, 'Bar 2');
    expect((await charge(5000, other.terminalToken)).statusCode).toBe(200);
  });

  it('an unknown card is answered as before, even at the limit', async () => {
    const { charge } = await setup();
    await charge(5000);
    const unknown = await charge(5, undefined, 'u', '04:00:00:01');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('unknown_card');
  });

  it('an admin can change the limit, clear it, and sees it in the list', async () => {
    const { app, adminToken, t, charge, setLimit } = await setup();
    expect((await setLimit(t.terminalId, 100)).json().chargeLimitHour).toBe(100);
    expect((await charge(100)).statusCode).toBe(200);
    expect((await charge(1)).statusCode).toBe(429);
    const list = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(list.find((x: { id: string }) => x.id === t.terminalId).chargeLimitHour).toBe(100);
    expect((await setLimit(t.terminalId, null)).json().chargeLimitHour).toBeNull();
    expect((await charge(9999)).statusCode).toBe(200);
    expect((await charge(9999)).statusCode).toBe(200);
  });

  it('rejects limits that are not whole numbers from 1 to 1000000', async () => {
    const { t, setLimit } = await setup();
    for (const bad of [0, -5, 1.5, '100', true, 1_000_001, {}]) expect((await setLimit(t.terminalId, bad)).statusCode).toBe(400);
  });

  it('only admins can change it, and only phones have one', async () => {
    const { app, adminToken, t } = await setup();
    const asPhone = await app.inject({ method: 'PATCH', url: `/terminals/${t.terminalId}`, headers: auth(t.terminalToken), payload: { chargeLimitHour: null } });
    expect(asPhone.statusCode).toBe(403);
    const reader = await makeReader(app, adminToken);
    const res = await app.inject({ method: 'PATCH', url: `/terminals/${reader.terminalId}`, headers: auth(adminToken), payload: { chargeLimitHour: 10 } });
    expect(res.statusCode).toBe(400);
  });
});
