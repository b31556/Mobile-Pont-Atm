import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, auth } from './helpers.js';

async function setup() {
  const ctx = await makeApp();
  const t = makeTerminal(ctx.app, ctx.db, 'Bar 2');
  const other = makeTerminal(ctx.app, ctx.db, 'Entrance');
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: '04A23B1C', points: 46 } })).json();
  const charge = (token: string, key: string, amount = 8) =>
    ctx.app.inject({ method: 'POST', url: '/charges', headers: auth(token), payload: { cardUid: '04:A2:3B:1C', amount, idempotencyKey: key } });
  return { ...ctx, t, other, anna, charge };
}

describe('a paired phone works with its terminal token alone (no sign-in)', () => {
  it('can charge, and the charge is recorded under the terminal, not a person', async () => {
    const { t, charge, db, anna } = await setup();
    const res = await charge(t.terminalToken, 'k1');
    expect(res.statusCode).toBe(200);
    expect(res.json().card).toMatchObject({ balanceBefore: 46, balance: 54 });
    const row = db.prepare('select operator_id, terminal_id from transactions').get() as { operator_id: string | null; terminal_id: string };
    expect(row.operator_id).toBeNull();
    expect(row.terminal_id).toBe(t.terminalId);
    expect((db.prepare('select balance from cards where id=?').get(anna.id) as { balance: number }).balance).toBe(54);
  });

  it('a repeated key still credits once', async () => {
    const { t, charge, anna, db } = await setup();
    await charge(t.terminalToken, 'same'); await charge(t.terminalToken, 'same');
    expect((db.prepare('select balance from cards where id=?').get(anna.id) as { balance: number }).balance).toBe(54);
  });

  it('lists only its own terminal’s transactions, with the terminal name as the operator', async () => {
    const { app, t, other, charge } = await setup();
    await charge(t.terminalToken, 'a'); await charge(other.terminalToken, 'b', 4);
    const list = (await app.inject({ method: 'GET', url: '/transactions', headers: auth(t.terminalToken) })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ amount: 8, terminal: 'Bar 2', operator: 'Bar 2' });
  });

  it('can storno its own charge; the reversing row has no person either', async () => {
    const { app, t, charge, db } = await setup();
    const id = (await charge(t.terminalToken, 'a')).json().transaction.id;
    const res = await app.inject({ method: 'POST', url: `/transactions/${id}/storno`, headers: auth(t.terminalToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.balance).toBe(46);
    const rev = db.prepare("select operator_id, terminal_id from transactions where type='storno'").get() as any;
    expect(rev).toEqual({ operator_id: null, terminal_id: t.terminalId });
  });

  it('cannot storno another terminal’s charge', async () => {
    const { app, t, other, charge } = await setup();
    const id = (await charge(other.terminalToken, 'b')).json().transaction.id;
    expect((await app.inject({ method: 'POST', url: `/transactions/${id}/storno`, headers: auth(t.terminalToken) })).statusCode).toBe(403);
  });

  it('reads and saves its presets and fetches holder photos', async () => {
    const { app, t, anna } = await setup();
    expect((await app.inject({ method: 'GET', url: '/presets', headers: auth(t.terminalToken) })).json().values).toEqual([4, 8, 12, 20]);
    const put = await app.inject({ method: 'PUT', url: '/presets', headers: auth(t.terminalToken), payload: { values: [5, 10], instantPreset: false } });
    expect(put.json()).toEqual({ values: [5, 10], instantPreset: false });
    expect((await app.inject({ method: 'GET', url: `/cards/${anna.id}/photo`, headers: auth(t.terminalToken) })).statusCode).toBe(200);
  });

  it('refreshes last_seen on each request', async () => {
    const { app, t, db } = await setup();
    await app.inject({ method: 'GET', url: '/presets', headers: auth(t.terminalToken) });
    expect((db.prepare('select last_seen from terminals where id=?').get(t.terminalId) as any).last_seen).toBeTruthy();
  });

  it('is refused on every admin route', async () => {
    const { app, t } = await setup();
    for (const [method, url] of [['GET', '/cards'], ['GET', '/staff'], ['GET', '/terminals'], ['POST', '/terminals']] as const) {
      expect((await app.inject({ method, url, headers: auth(t.terminalToken), payload: {} })).statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('stops working the moment the terminal is revoked', async () => {
    const { app, t, adminToken, charge } = await setup();
    await app.inject({ method: 'DELETE', url: `/terminals/${t.terminalId}`, headers: auth(adminToken) });
    const res = await charge(t.terminalToken, 'x');
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('This phone was revoked');
  });

  it('a token for a terminal that does not exist is refused', async () => {
    const { app, charge } = await setup();
    const ghost = app.jwt.sign({ kind: 'terminal', terminalId: 'nope' });
    expect((await charge(ghost, 'x')).statusCode).toBe(401);
  });

  it('signing in as staff still works for existing sessions', async () => {
    const { app, db, charge } = await setup();
    const { makeOperator } = await import('./helpers.js');
    const op = await makeOperator(app, db, 'old@pont.example', 'Merch');
    expect((await charge(op.token, 'legacy')).statusCode).toBe(200);
  });
});
