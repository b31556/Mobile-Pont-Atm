import { describe, it, expect } from 'vitest';
import { makeApp, makeReader, makeTerminal, auth } from './helpers.js';
import { DEFAULT_SETTINGS, defaultZone } from '../src/presence.js';

const UID = '04:A2:3B:1C';

async function setup(mode: 'fixed' | 'presence' = 'fixed') {
  const ctx = await makeApp();
  const reader = await makeReader(ctx.app, ctx.adminToken, { name: 'Gift reader', mode });
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: UID, points: 46 } })).json();
  const patch = (body: object, id = reader.terminalId) => ctx.app.inject({ method: 'PATCH', url: `/terminals/${id}`, headers: auth(ctx.adminToken), payload: body });
  const code = async (id = reader.terminalId) => ((await ctx.app.inject({ method: 'GET', url: '/terminals', headers: auth(ctx.adminToken) })).json() as any[]).find(t => t.id === id).displayCode as string;
  const signIn = async (id = reader.terminalId) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/display/enter', payload: { code: await code(id) } });
    return { res, cookie: (([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0] };
  };
  let n = 0;
  const tap = (path: string, token = reader.terminalToken, uid = UID) => ctx.app.inject({ method: 'POST', url: path, headers: auth(token), payload: { cardUid: uid, idempotencyKey: `k${++n}` } });
  const cancel = (cookie: string, seq: unknown) => ctx.app.inject({ method: 'POST', url: '/display/cancel', headers: { cookie }, payload: { seq } });
  const balance = () => (ctx.db.prepare('select balance from cards where id=?').get(anna.id) as { balance: number }).balance;
  const last = (id = reader.terminalId) => ctx.app.displayHub.last(id)!;
  return { ...ctx, reader, anna, patch, signIn, tap, cancel, balance, last };
}

describe('the switch', () => {
  it('is off for every reader until an admin turns it on, and the screen is told', async () => {
    const c = await setup();
    const list = async () => ((await c.app.inject({ method: 'GET', url: '/terminals', headers: auth(c.adminToken) })).json() as any[]).find(t => t.id === c.reader.terminalId);
    expect((await list()).displayCancel).toBe(false);
    const { cookie } = await c.signIn();
    const state = async () => (await c.app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).json();
    expect((await state()).canCancel).toBe(false);
    expect((await c.patch({ displayCancel: true })).statusCode).toBe(200);
    expect((await list()).displayCancel).toBe(true);
    expect((await state()).canCancel).toBe(true);
    expect((await c.patch({ displayCancel: 'yes' })).statusCode).toBe(400);
  });

  it('only an admin can change it', async () => {
    const c = await setup();
    const res = await c.app.inject({ method: 'PATCH', url: `/terminals/${c.reader.terminalId}`, headers: auth(c.reader.terminalToken), payload: { displayCancel: true } });
    expect(res.statusCode).toBe(403);
  });
});

describe('cancelling a grant from the display page', () => {
  it('refuses while switched off, and for a screen that is not signed in', async () => {
    const c = await setup();
    await c.tap('/fixed/tap');
    const { cookie } = await c.signIn();
    const off = await c.cancel(cookie, c.last().seq);
    expect(off.statusCode).toBe(403);
    expect(off.json().code).toBe('switched_off');
    expect(c.balance()).toBe(56);
    expect((await c.app.inject({ method: 'POST', url: '/display/cancel', payload: { seq: 1 } })).statusCode).toBe(401);
  });

  it('takes the points back, and tells the screen', async () => {
    const c = await setup();
    await c.patch({ displayCancel: true });
    const { cookie } = await c.signIn();
    await c.tap('/fixed/tap');
    const shown = c.last();
    expect(shown.ref).toMatchObject({ type: 'tx' });
    expect(c.balance()).toBe(56);
    const res = await c.cancel(cookie, shown.seq);
    expect(res.statusCode).toBe(200);
    expect(c.balance()).toBe(46);
    expect(c.last()).toMatchObject({ headline: 'Cancelled', details: ['The charge was cancelled: 10 points taken back.'] });
    expect(c.db.prepare("select status from transactions where type='give'").get()).toEqual({ status: 'stornoed' });
  });

  it('cancelling twice does nothing the second time', async () => {
    const c = await setup();
    await c.patch({ displayCancel: true });
    const { cookie } = await c.signIn();
    await c.tap('/fixed/tap');
    const seq = c.last().seq;
    expect((await c.cancel(cookie, seq)).statusCode).toBe(200);
    const again = await c.cancel(cookie, seq);
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('already_stornoed');
    expect(c.balance()).toBe(46);
  });

  it('only what this screen showed: a made-up number, an old one and a "Cancelled" notice cannot be cancelled', async () => {
    const c = await setup();
    await c.patch({ displayCancel: true });
    const { cookie } = await c.signIn();
    await c.tap('/fixed/tap');
    expect((await c.cancel(cookie, 99999)).json().code).toBe('too_old');
    expect((await c.cancel(cookie, 'x')).statusCode).toBe(404);
    expect((await c.cancel(cookie, undefined)).statusCode).toBe(404);
    const seq = c.last().seq;
    await c.cancel(cookie, seq);
    expect((await c.cancel(cookie, c.last().seq)).json().code).toBe('too_old');        // the "Cancelled" notice has nothing to undo
  });

  it('a charge more than ten minutes old is too old to undo from a wall screen', async () => {
    const c = await setup();
    await c.patch({ displayCancel: true });
    const { cookie } = await c.signIn();
    await c.tap('/fixed/tap');
    const seq = c.last().seq;
    c.app.displayHub.find(c.reader.terminalId, seq)!.atMs = Date.now() - 11 * 60 * 1000;
    const res = await c.cancel(cookie, seq);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('too_old');
    expect(c.balance()).toBe(56);
  });

  it('a screen can never cancel another reader’s charge', async () => {
    const c = await setup();
    const other = await makeReader(c.app, c.adminToken, { name: 'Other reader' });
    await c.patch({ displayCancel: true }, other.terminalId);
    const mine = await c.tap('/fixed/tap');                              // on the first reader
    expect(mine.statusCode).toBe(200);
    // the other reader's screen is signed in and allowed, but the event of the first reader is not one of ITS events
    const { cookie } = await c.signIn(other.terminalId);
    expect((await c.cancel(cookie, c.last().seq)).json().code).toBe('too_old');
    expect(c.balance()).toBe(56);
  });

  it('a charge that is refused because the card spent the points cannot be cancelled, and says so', async () => {
    const c = await setup();
    await c.patch({ displayCancel: true });
    const { cookie } = await c.signIn();
    await c.tap('/fixed/tap');
    c.db.prepare('update cards set balance=3 where id=?').run(c.anna.id);
    const res = await c.cancel(cookie, c.last().seq);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('would_go_negative');
    expect(c.balance()).toBe(3);
  });

  it('an ATM phone’s charge can be cancelled from its screen too', async () => {
    const c = await setup();
    const phone = makeTerminal(c.app, c.db, 'Bar phone');
    await c.patch({ displayCancel: true }, phone.terminalId);
    const { cookie } = await c.signIn(phone.terminalId);
    await c.app.inject({ method: 'POST', url: '/charges', headers: auth(phone.terminalToken), payload: { cardUid: UID, amount: 8, idempotencyKey: 'a1' } });
    expect(c.last(phone.terminalId).ref).toMatchObject({ type: 'tx' });
    expect((await c.cancel(cookie, c.last(phone.terminalId).seq)).statusCode).toBe(200);
    expect(c.balance()).toBe(46);
  });
});

describe('cancelling a check-in or check-out from the display page', () => {
  async function gate() {
    const c = await setup('presence');
    const zone = defaultZone(c.db);
    await c.app.inject({ method: 'PUT', url: `/zones/${zone.id}`, headers: auth(c.adminToken), payload: { settings: { ...DEFAULT_SETTINGS, cooldownSeconds: 0 } } });
    await c.patch({ displayCancel: true, direction: 'toggle' });
    const { cookie } = await c.signIn();
    return { ...c, cookie };
  }

  it('cancels the check-in it showed', async () => {
    const c = await gate();
    await c.tap('/presence/tap');
    expect(c.last().ref).toMatchObject({ type: 'visit', expect: 'in' });
    expect((await c.cancel(c.cookie, c.last().seq)).statusCode).toBe(200);
    expect(c.db.prepare('select status from presence_sessions').all()).toEqual([{ status: 'discarded' }]);
    expect(c.last()).toMatchObject({ headline: 'Cancelled', details: ['The check-in was cancelled.'] });
  });

  it('cancels the check-out it showed: points back, visit open again', async () => {
    const c = await gate();
    await c.tap('/presence/tap');
    c.db.prepare("update presence_sessions set in_at=?").run(new Date(Date.now() - 40 * 60000).toISOString());
    await c.tap('/presence/tap');
    expect(c.last().ref).toMatchObject({ type: 'visit', expect: 'out' });
    expect(c.balance()).toBe(70);
    expect((await c.cancel(c.cookie, c.last().seq)).statusCode).toBe(200);
    expect(c.balance()).toBe(46);
    expect(c.db.prepare('select status from presence_sessions').all()).toEqual([{ status: 'open' }]);
  });
});
