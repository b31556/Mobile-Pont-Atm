import { describe, it, expect } from 'vitest';
import { makeApp, auth, login } from './helpers.js';
import { seedStaff } from '../src/auth.js';

async function createTerminal(app: any, adminToken: string, name = 'Bar 2') {
  const res = await app.inject({ method: 'POST', url: '/terminals', headers: auth(adminToken), payload: { name, place: 'Main hall' } });
  return res;
}

describe('terminals and pairing', () => {
  it('creating a terminal returns a 6-digit pairing code', async () => {
    const { app, adminToken } = await makeApp();
    const res = await createTerminal(app, adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().pairingCode).toMatch(/^\d{6}$/);
    expect(res.json().terminal.name).toBe('Bar 2');
  });

  it('pairing with the code returns a terminal token that works at operator login', async () => {
    const { app, db, adminToken } = await makeApp();
    const created = (await createTerminal(app, adminToken)).json();
    const pair = await app.inject({ method: 'POST', url: '/pair', payload: { code: created.pairingCode, device: 'Redmi 12', appVersion: '0.1.0' } });
    expect(pair.statusCode).toBe(200);
    expect(pair.json().terminal).toMatchObject({ id: created.terminal.id, name: 'Bar 2' });
    seedStaff(db, { name: 'Eszter', email: 'e@pont.example', password: 'pw123456', role: 'operator' });
    expect(await login(app, 'e@pont.example', 'pw123456', pair.json().terminalToken)).toBeTruthy();
    const row = db.prepare('select device, app_version from terminals where id=?').get(created.terminal.id) as any;
    expect(row).toEqual({ device: 'Redmi 12', app_version: '0.1.0' });
  });

  it('a code cannot be used twice', async () => {
    const { app, adminToken } = await makeApp();
    const created = (await createTerminal(app, adminToken)).json();
    const body = { code: created.pairingCode, device: 'x', appVersion: '1' };
    expect((await app.inject({ method: 'POST', url: '/pair', payload: body })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/pair', payload: body });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: 'Code already used or expired' });
  });

  it('an expired code is refused', async () => {
    const { app, db, adminToken } = await makeApp();
    const created = (await createTerminal(app, adminToken)).json();
    db.prepare('update pairing_codes set expires_at=?').run(Date.now() - 1000);
    const res = await app.inject({ method: 'POST', url: '/pair', payload: { code: created.pairingCode, device: 'x', appVersion: '1' } });
    expect(res.statusCode).toBe(400);
  });

  it('a wrong code is refused', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/pair', payload: { code: '000000', device: 'x', appVersion: '1' } });
    expect(res.statusCode).toBe(400);
  });

  it('after revoke, operator login with that terminal token is 401 and an existing operator token stops working', async () => {
    const { app, db, adminToken } = await makeApp();
    const created = (await createTerminal(app, adminToken)).json();
    const pair = (await app.inject({ method: 'POST', url: '/pair', payload: { code: created.pairingCode, device: 'x', appVersion: '1' } })).json();
    seedStaff(db, { name: 'Eszter', email: 'e@pont.example', password: 'pw123456', role: 'operator' });
    const opToken = await login(app, 'e@pont.example', 'pw123456', pair.terminalToken);
    const del = await app.inject({ method: 'DELETE', url: `/terminals/${created.terminal.id}`, headers: auth(adminToken) });
    expect(del.statusCode).toBe(200);
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'e@pont.example', password: 'pw123456', terminalToken: pair.terminalToken } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'This phone was revoked' });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(opToken) })).statusCode).toBe(401);
  });

  it('GET /terminals lists active terminals with online status, and hides revoked ones', async () => {
    const { app, db, adminToken } = await makeApp();
    const a = (await createTerminal(app, adminToken, 'Bar 2')).json();
    const b = (await createTerminal(app, adminToken, 'Entrance')).json();
    db.prepare("update terminals set last_seen=? where id=?").run(new Date().toISOString(), a.terminal.id);
    await app.inject({ method: 'DELETE', url: `/terminals/${b.terminal.id}`, headers: auth(adminToken) });
    const list = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(list.map((t: any) => t.name)).toEqual(['Bar 2']);
    expect(list[0]).toMatchObject({ online: true, givenToday: 0 });
  });

  it('heartbeat updates last_seen for a terminal token', async () => {
    const { app, db, adminToken } = await makeApp();
    const created = (await createTerminal(app, adminToken)).json();
    const pair = (await app.inject({ method: 'POST', url: '/pair', payload: { code: created.pairingCode, device: 'x', appVersion: '1' } })).json();
    const res = await app.inject({ method: 'POST', url: '/heartbeat', headers: auth(pair.terminalToken) });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('select last_seen from terminals where id=?').get(created.terminal.id) as any;
    expect(row.last_seen).toBeTruthy();
  });

  it('non-admins cannot create terminals', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/terminals', payload: { name: 'x' } })).statusCode).toBe(401);
  });
});
