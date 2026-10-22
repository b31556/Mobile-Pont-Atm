import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, auth, login, makeOperator } from './helpers.js';
import { seedStaff } from '../src/auth.js';

describe('staff auth', () => {
  it('admin login returns a token and user', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'adminpass' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ name: 'Admin', role: 'admin' });
    expect(typeof res.json().token).toBe('string');
  });

  it('wrong password returns 401', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Wrong email or password' });
  });

  it('operator login without terminalToken returns 400', async () => {
    const { app, db } = await makeApp();
    seedStaff(db, { name: 'Eszter', email: 'e@pont.example', password: 'pw123456', role: 'operator' });
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'e@pont.example', password: 'pw123456' } });
    expect(res.statusCode).toBe(400);
  });

  it('operator login with a terminal token binds the terminal', async () => {
    const { app, db } = await makeApp();
    const { token, terminalId } = await makeOperator(app, db);
    expect(app.jwt.decode<{ terminalId: string }>(token)!.terminalId).toBe(terminalId);
  });

  it('GET /staff without a token is 401, operator token is 403, admin is 200', async () => {
    const { app, db, adminToken } = await makeApp();
    const op = await makeOperator(app, db);
    expect((await app.inject({ method: 'GET', url: '/staff' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/staff', headers: auth(op.token) })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/staff', headers: auth(adminToken) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().map((s: { email: string }) => s.email)).toContain('admin@pont.example');
    expect(JSON.stringify(ok.json())).not.toContain('password');
  });

  it('a deactivated operator token is refused with 401', async () => {
    const { app, db, adminToken } = await makeApp();
    const op = await makeOperator(app, db);
    const staff = (await app.inject({ method: 'GET', url: '/staff', headers: auth(adminToken) })).json();
    const id = staff.find((s: { email: string }) => s.email === 'eszter@pont.example').id;
    const patch = await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { active: false } });
    expect(patch.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(op.token) });
    expect(res.statusCode).toBe(401);
  });

  it('a deactivated staff member cannot log in', async () => {
    const { app, db } = await makeApp();
    seedStaff(db, { name: 'Gone', email: 'gone@pont.example', password: 'pw123456', role: 'admin' });
    db.prepare("update staff set active=0 where email='gone@pont.example'").run();
    await expect(login(app, 'gone@pont.example', 'pw123456')).rejects.toThrow(/401/);
  });

  it('POST /staff creates a staff member who can log in', async () => {
    const { app, adminToken } = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/staff', headers: auth(adminToken), payload: { name: 'Márk', email: 'mark@pont.example', password: 'temp1234', role: 'admin' } });
    expect(res.statusCode).toBe(201);
    expect(await login(app, 'mark@pont.example', 'temp1234')).toBeTruthy();
  });

  it('terminal token for an unknown terminal is refused at login', async () => {
    const { app, db } = await makeApp();
    seedStaff(db, { name: 'E', email: 'e2@pont.example', password: 'pw123456', role: 'operator' });
    const bad = app.jwt.sign({ kind: 'terminal', terminalId: 'nope' });
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'e2@pont.example', password: 'pw123456', terminalToken: bad } });
    expect(res.statusCode).toBe(401);
    void makeTerminal;
  });
});

describe('token lifetime and revocation', () => {
  it('staff tokens expire after 12 hours', async () => {
    const { app, adminToken } = await makeApp();
    const p = app.jwt.decode<{ iat: number; exp: number }>(adminToken)!;
    expect(p.exp - p.iat).toBe(12 * 60 * 60);
  });

  it('an expired staff token is refused', async () => {
    const { app, db } = await makeApp();
    const id = (db.prepare("select id from staff where email='admin@pont.example'").get() as { id: string }).id;
    const old = Math.floor(Date.now() / 1000) - 13 * 3600;
    const token = app.jwt.sign({ kind: 'staff', id, role: 'admin', v: 0, iat: old } as any, { expiresIn: 12 * 3600 });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })).statusCode).toBe(401);
  });

  it('a password reset signs out the old token but the new password works', async () => {
    const { app, db, adminToken } = await makeApp();
    const op = await makeOperator(app, db);
    const id = (db.prepare("select id from staff where email='eszter@pont.example'").get() as { id: string }).id;
    const patch = await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { password: 'brand-new-pw' } });
    expect(patch.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(op.token) })).statusCode).toBe(401);
    expect(await login(app, 'eszter@pont.example', 'brand-new-pw', op.terminalToken)).toBeTruthy();
  });

  it('switching an account off and on again does not revive its old token', async () => {
    const { app, db, adminToken } = await makeApp();
    const op = await makeOperator(app, db);
    const id = (db.prepare("select id from staff where email='eszter@pont.example'").get() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { active: false } });
    await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { active: true } });
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(op.token) })).statusCode).toBe(401);
  });
});

describe('attempt limits', () => {
  const bad = (app: any, email = 'admin@pont.example') =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong' } });

  it('locks login after 10 wrong passwords, even for the right one', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i++) expect((await bad(app)).statusCode).toBe(401);
    const blocked = await bad(app);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many attempts/);
    const right = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'adminpass' } });
    expect(right.statusCode).toBe(429);
  });

  it('a different account is not locked by someone else’s failures', async () => {
    const { app, db } = await makeApp();
    seedStaff(db, { name: 'Other', email: 'other@pont.example', password: 'pw123456', role: 'admin' });
    for (let i = 0; i < 11; i++) await bad(app);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'other@pont.example', password: 'pw123456' } })).statusCode).toBe(200);
  });

  it('a successful login resets the counter', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 9; i++) await bad(app);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'adminpass' } })).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await bad(app)).statusCode).toBe(401);
  });

  it('locks pairing after 10 wrong codes', async () => {
    const { app } = await makeApp();
    const pair = (code: string) => app.inject({ method: 'POST', url: '/pair', payload: { code, device: 'x', appVersion: '1' } });
    for (let i = 0; i < 10; i++) expect((await pair(String(100000 + i))).statusCode).toBe(400);
    expect((await pair('999999')).statusCode).toBe(429);
  });

  it('clients behind a trusted proxy are counted separately by forwarded address', async () => {
    const { buildApp } = await import('../src/app.js');
    const { openDb } = await import('../src/db.js');
    const app = buildApp({ db: openDb(':memory:'), jwtSecret: 's', trustProxy: true });
    await app.ready();
    const pair = (ip: string) => app.inject({ method: 'POST', url: '/pair', headers: { 'x-forwarded-for': ip }, payload: { code: '000000', device: 'x', appVersion: '1' } });
    for (let i = 0; i < 10; i++) await pair('10.0.0.1');
    expect((await pair('10.0.0.1')).statusCode).toBe(429);
    expect((await pair('10.0.0.2')).statusCode).toBe(400);
  });
});
