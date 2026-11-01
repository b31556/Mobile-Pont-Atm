import { describe, it, expect } from 'vitest';
import { makeApp, makeOperator, auth } from './helpers.js';
import { seedStaff } from '../src/auth.js';

const KEY = '04:C0:FF:EE';

async function setup() {
  const ctx = await makeApp();
  const adminId = (ctx.db.prepare("select id from staff where email='admin@pont.example'").get() as { id: string }).id;
  const setKey = (id: string, uid: unknown, token = ctx.adminToken) => ctx.app.inject({ method: 'PUT', url: `/staff/${id}/key`, headers: auth(token), payload: { uid } });
  const removeKey = (id: string, token = ctx.adminToken) => ctx.app.inject({ method: 'DELETE', url: `/staff/${id}/key`, headers: auth(token) });
  const keyLogin = (uid: unknown, extra: object = {}) => ctx.app.inject({ method: 'POST', url: '/auth/key-login', payload: { uid, ...extra } });
  const staff = async () => (await ctx.app.inject({ method: 'GET', url: '/staff', headers: auth(ctx.adminToken) })).json() as any[];
  const lifetime = (token: string) => { const p = ctx.app.jwt.decode<{ iat: number; exp: number }>(token)!; return p.exp - p.iat; };
  const works = async (token: string) => (await ctx.app.inject({ method: 'GET', url: '/staff', headers: auth(token) })).statusCode === 200;
  return { ...ctx, adminId, setKey, removeKey, keyLogin, staff, lifetime, works };
}

describe('setting a key', () => {
  it('shows in the staff list as a key with its last byte, never the whole UID', async () => {
    const c = await setup();
    expect((await c.setKey(c.adminId, KEY)).statusCode).toBe(200);
    const me = (await c.staff()).find(s => s.id === c.adminId);
    expect(me).toMatchObject({ hasKey: true, keyHint: '…EE' });
    expect(JSON.stringify(await c.staff())).not.toContain('C0:FF');
    expect(JSON.stringify(me)).not.toContain('key_uid');
  });

  it('takes any spelling of the UID', async () => {
    const c = await setup();
    expect((await c.setKey(c.adminId, '04c0ffee')).statusCode).toBe(200);
    expect((await c.keyLogin('04-C0-FF-EE')).statusCode).toBe(200);
  });

  it('refuses a bad UID, a missing person, an operator, and a non-admin caller', async () => {
    const c = await setup();
    for (const uid of ['', 'nonsense', '04C0FF', undefined, 12345]) expect((await c.setKey(c.adminId, uid)).statusCode).toBe(400);
    expect((await c.setKey('nobody', KEY)).statusCode).toBe(404);
    const op = await makeOperator(c.app, c.db);
    const opId = (c.db.prepare("select id from staff where email='eszter@pont.example'").get() as { id: string }).id;
    expect((await c.setKey(opId, KEY)).statusCode).toBe(400);
    expect((await c.setKey(c.adminId, KEY, op.token)).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'PUT', url: `/staff/${c.adminId}/key`, payload: { uid: KEY } })).statusCode).toBe(401);
  });

  it('a key can’t also be a points card, and a card can’t become a key', async () => {
    const c = await setup();
    const card = (await c.app.inject({ method: 'POST', url: '/cards', headers: auth(c.adminToken), payload: { name: 'Anna', uid: '05:00:00:01', points: 5 } })).json();
    expect((await c.setKey(c.adminId, '05:00:00:01')).statusCode).toBe(409);
    expect((await c.setKey(c.adminId, KEY)).statusCode).toBe(200);
    const create = await c.app.inject({ method: 'POST', url: '/cards', headers: auth(c.adminToken), payload: { name: 'Ben', uid: KEY } });
    expect(create.statusCode).toBe(409); expect(create.json().error).toMatch(/sign-in key/);
    expect((await c.app.inject({ method: 'PATCH', url: `/cards/${card.id}`, headers: auth(c.adminToken), payload: { uid: KEY } })).statusCode).toBe(409);
    const check = await c.app.inject({ method: 'POST', url: '/cards/import/check', headers: auth(c.adminToken), payload: { rows: [{ name: 'Cleo', uid: KEY }] } });
    expect(check.json().results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/sign-in key/) });
  });

  it('two admins can’t share a key, and setting your own again changes nothing', async () => {
    const c = await setup();
    seedStaff(c.db, { name: 'Dora', email: 'dora@pont.example', password: 'pw123456', role: 'admin' });
    const dora = (c.db.prepare("select id from staff where email='dora@pont.example'").get() as { id: string }).id;
    expect((await c.setKey(c.adminId, KEY)).statusCode).toBe(200);
    const taken = await c.setKey(dora, KEY);
    expect(taken.statusCode).toBe(409); expect(taken.json().error).toMatch(/already belongs to Admin/);
    expect((await c.setKey(c.adminId, KEY)).statusCode).toBe(200);
    expect(await c.works(c.adminToken)).toBe(true);   // the same key again does not sign anyone out
  });
});

describe('signing in with a key', () => {
  it('gives the admin a token, 12 hours or a week when remembered', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    const a = await c.keyLogin(KEY);
    expect(a.statusCode).toBe(200);
    expect(a.json().user).toMatchObject({ id: c.adminId, role: 'admin' });
    expect(await c.works(a.json().token)).toBe(true);
    expect(c.lifetime(a.json().token)).toBe(12 * 3600);
    expect(c.lifetime((await c.keyLogin(KEY, { remember: true })).json().token)).toBe(7 * 24 * 3600);
    expect(c.lifetime((await c.keyLogin(KEY, { remember: 'yes' })).json().token)).toBe(12 * 3600);
  });

  it('says the same thing for every key it does not know', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    for (const uid of ['04:AA:AA:AA', 'junk', '', null, 7]) {
      const r = await c.keyLogin(uid);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'That key is not recognised' });
    }
  });

  it('does not work for a switched-off admin', async () => {
    const c = await setup();
    seedStaff(c.db, { name: 'Dora', email: 'dora@pont.example', password: 'pw123456', role: 'admin' });
    const dora = (c.db.prepare("select id from staff where email='dora@pont.example'").get() as { id: string }).id;
    await c.setKey(dora, KEY);
    expect((await c.keyLogin(KEY)).statusCode).toBe(200);
    await c.app.inject({ method: 'PATCH', url: `/staff/${dora}`, headers: auth(c.adminToken), payload: { active: false } });
    expect((await c.keyLogin(KEY)).statusCode).toBe(401);
  });

  it('a card that is only a points card does not sign anyone in', async () => {
    const c = await setup();
    await c.app.inject({ method: 'POST', url: '/cards', headers: auth(c.adminToken), payload: { name: 'Anna', uid: '05:00:00:01' } });
    expect((await c.keyLogin('05:00:00:01')).statusCode).toBe(401);
  });

  it('is limited: ten misses lock the address, even for the right key', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    for (let i = 0; i < 10; i++) expect((await c.keyLogin(`04:00:00:${i.toString(16).padStart(2, '0')}`)).statusCode).toBe(401);
    expect((await c.keyLogin('04:00:00:FF')).statusCode).toBe(429);
    expect((await c.keyLogin(KEY)).statusCode).toBe(429);
  });
});

describe('changing or removing a key', () => {
  it('a new key ends the sign-ins made with the old one', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    const signedIn = (await c.keyLogin(KEY)).json().token as string;
    expect(await c.works(signedIn)).toBe(true);
    expect((await c.setKey(c.adminId, '04:BA:BE:01')).statusCode).toBe(200);
    expect(await c.works(signedIn)).toBe(false);
    expect((await c.keyLogin(KEY)).statusCode).toBe(401);
    expect((await c.keyLogin('04:BA:BE:01')).statusCode).toBe(200);
  });

  it('removing it ends the sign-ins made with it, and the card is free to be a points card', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    const signedIn = (await c.keyLogin(KEY)).json().token as string;
    const r = await c.removeKey(c.adminId, c.adminToken);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ hasKey: false, keyHint: null });
    expect(await c.works(signedIn)).toBe(false);
    const again = (await c.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'adminpass' } })).json().token;
    expect((await c.app.inject({ method: 'POST', url: '/cards', headers: auth(again), payload: { name: 'Ben', uid: KEY } })).statusCode).toBe(201);
    expect((await c.app.inject({ method: 'DELETE', url: '/staff/nobody/key', headers: auth(again) })).statusCode).toBe(404);
  });

  it('a password change also ends a key sign-in, like any other', async () => {
    const c = await setup();
    await c.setKey(c.adminId, KEY);
    const signedIn = (await c.keyLogin(KEY, { remember: true })).json().token as string;
    await c.app.inject({ method: 'PATCH', url: `/staff/${c.adminId}`, headers: auth(c.adminToken), payload: { password: 'a-new-password' } });
    expect(await c.works(signedIn)).toBe(false);
  });
});
