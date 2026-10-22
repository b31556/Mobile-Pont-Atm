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
