import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, auth } from './helpers.js';

async function setup() {
  const ctx = await makeApp();
  const bar = makeTerminal(ctx.app, ctx.db, 'Bar 2');
  const door = makeTerminal(ctx.app, ctx.db, 'Entrance');
  const suggest = (token: string, cardUid: string) =>
    ctx.app.inject({ method: 'POST', url: '/card-suggestions', headers: auth(token), payload: { cardUid } });
  const list = async () => (await ctx.app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(ctx.adminToken) })).json();
  return { ...ctx, bar, door, suggest, list };
}

describe('card suggestions', () => {
  it('a terminal can suggest an unregistered card and the admin sees it with where it was tapped', async () => {
    const { bar, suggest, list } = await setup();
    const res = await suggest(bar.terminalToken, '04:EE:00:77');
    expect(res.statusCode).toBe(200);
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: '04:EE:00:77', terminal: 'Bar 2', count: 1 });
    expect(rows[0].firstSeen).toBeTruthy(); expect(rows[0].lastSeen).toBeTruthy();
  });

  it('suggesting the same card again counts it once more and keeps one row', async () => {
    const { bar, door, suggest, list } = await setup();
    await suggest(bar.terminalToken, '04:EE:00:77');
    await suggest(door.terminalToken, '04:EE:00:77');
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, terminal: 'Entrance' });
  });

  it('normalizes the UID format', async () => {
    const { bar, suggest, list } = await setup();
    await suggest(bar.terminalToken, '04ee0077');
    expect((await list())[0].uid).toBe('04:EE:00:77');
  });

  it('refuses a card that is already registered', async () => {
    const { app, adminToken, bar, suggest, list } = await setup();
    await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Anna', uid: '04A23B1C' } });
    const res = await suggest(bar.terminalToken, '04:A2:3B:1C');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'already_registered', error: 'That card is already registered.' });
    expect(await list()).toHaveLength(0);
  });

  it('refuses a UID that is not a card UID', async () => {
    const { bar, suggest } = await setup();
    expect((await suggest(bar.terminalToken, 'hello')).statusCode).toBe(400);
  });

  it('only admins can read or dismiss suggestions', async () => {
    const { app, bar, suggest } = await setup();
    await suggest(bar.terminalToken, '04:EE:00:77');
    expect((await app.inject({ method: 'GET', url: '/card-suggestions' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(bar.terminalToken) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/card-suggestions/04:EE:00:77', headers: auth(bar.terminalToken) })).statusCode).toBe(403);
  });

  it('a revoked phone cannot suggest', async () => {
    const { app, adminToken, bar, suggest } = await setup();
    await app.inject({ method: 'DELETE', url: `/terminals/${bar.terminalId}`, headers: auth(adminToken) });
    expect((await suggest(bar.terminalToken, '04:EE:00:77')).statusCode).toBe(401);
  });

  it('adding the card in admin clears its suggestion', async () => {
    const { app, adminToken, bar, suggest, list } = await setup();
    await suggest(bar.terminalToken, '04:EE:00:77');
    const add = await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Dóra', uid: '04:EE:00:77', points: 5 } });
    expect(add.statusCode).toBe(201);
    expect(await list()).toHaveLength(0);
  });

  it('the admin can dismiss a suggestion; dismissing a missing one is 404', async () => {
    const { app, adminToken, bar, suggest, list } = await setup();
    await suggest(bar.terminalToken, '04:EE:00:77');
    const del = await app.inject({ method: 'DELETE', url: '/card-suggestions/04:EE:00:77', headers: auth(adminToken) });
    expect(del.statusCode).toBe(200);
    expect(await list()).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: '/card-suggestions/04:EE:00:77', headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('newest suggestion is listed first', async () => {
    const { bar, suggest, list, db } = await setup();
    await suggest(bar.terminalToken, '04:11:11:11');
    db.prepare("update card_suggestions set last_seen='2026-01-01T00:00:00.000Z'").run();
    await suggest(bar.terminalToken, '04:22:22:22');
    expect((await list()).map((r: { uid: string }) => r.uid)).toEqual(['04:22:22:22', '04:11:11:11']);
  });
});
