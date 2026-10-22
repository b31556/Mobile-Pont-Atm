import { describe, it, expect } from 'vitest';
import { makeApp, auth, makeOperator } from './helpers.js';

const get = (app: any, token: string) => app.inject({ method: 'GET', url: '/presets', headers: auth(token) });
const put = (app: any, token: string, body: object) => app.inject({ method: 'PUT', url: '/presets', headers: auth(token), payload: body });

describe('presets', () => {
  it('a new terminal gets the defaults and instantPreset on', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    expect((await get(app, op.token)).json()).toEqual({ values: [4, 8, 12, 20], instantPreset: true });
  });

  it('saving stores values sorted ascending', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    const res = await put(app, op.token, { values: [12, 4], instantPreset: false });
    expect(res.json()).toEqual({ values: [4, 12], instantPreset: false });
    expect((await get(app, op.token)).json()).toEqual({ values: [4, 12], instantPreset: false });
  });

  it('an emptied list stays empty and does not revert to the defaults', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    await put(app, op.token, { values: [], instantPreset: true });
    expect((await get(app, op.token)).json().values).toEqual([]);
  });

  it.each([
    [[20, 4, 4]], [[1, 2, 3, 4, 5, 6, 7, 8, 9]], [[0]], [[10000]], [[1.5]], [['8']],
  ])('rejects %j with 400 and keeps the old list', async values => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    const res = await put(app, op.token, { values, instantPreset: true });
    expect(res.statusCode).toBe(400);
    expect((await get(app, op.token)).json().values).toEqual([4, 8, 12, 20]);
  });

  it('presets are per terminal', async () => {
    const { app, db } = await makeApp();
    const a = await makeOperator(app, db, 'a@pont.example', 'Bar 2');
    const b = await makeOperator(app, db, 'b@pont.example', 'Entrance');
    await put(app, a.token, { values: [5], instantPreset: true });
    expect((await get(app, b.token)).json().values).toEqual([4, 8, 12, 20]);
  });

  it('two operators on the same terminal share presets', async () => {
    const { app, db, adminToken } = await makeApp();
    const a = await makeOperator(app, db, 'a@pont.example', 'Bar 2');
    const { seedStaff } = await import('../src/auth.js');
    const { login } = await import('./helpers.js');
    seedStaff(db, { name: 'Second', email: 'c@pont.example', password: 'pw123456', role: 'operator' });
    const second = await login(app, 'c@pont.example', 'pw123456', app.jwt.sign({ kind: 'terminal', terminalId: a.terminalId }));
    await put(app, a.token, { values: [7], instantPreset: true });
    expect((await get(app, second)).json().values).toEqual([7]);
    void adminToken;
  });

  it('admins have no terminal and are refused', async () => {
    const { app, adminToken } = await makeApp();
    expect((await get(app, adminToken)).statusCode).toBe(403);
  });
});
