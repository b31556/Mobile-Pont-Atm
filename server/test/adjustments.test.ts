import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, auth, makeOperator } from './helpers.js';
import { openDb } from '../src/db.js';

async function setup() {
  const ctx = await makeApp();
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: '04A23B1C', points: 46 } })).json();
  const adjust = (delta: number, reason?: unknown) =>
    ctx.app.inject({ method: 'POST', url: `/cards/${anna.id}/adjust`, headers: auth(ctx.adminToken), payload: { delta, reason } });
  const list = async (token = ctx.adminToken, query = '') => (await ctx.app.inject({ method: 'GET', url: `/transactions${query}`, headers: auth(token) })).json();
  return { ...ctx, anna, adjust, list };
}

describe('admin grants and deductions in the transaction list', () => {
  it('a grant shows up with who did it, why, and the amount', async () => {
    const { adjust, list, anna } = await setup();
    expect((await adjust(5, 'Won the quiz')).statusCode).toBe(200);
    const rows = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'adjust', kind: 'adjust', amount: 5, status: 'ok', operator: 'Admin', note: 'Won the quiz', terminal: '', ref: null, card: { id: anna.id, name: 'Anna Kovács' } });
    expect(rows[0].createdAt).toBeTruthy(); expect(rows[0].id).toBeTruthy();
  });

  it('a deduction is negative', async () => {
    const { adjust, list } = await setup();
    await adjust(-3, 'Broke a cup');
    expect((await list())[0]).toMatchObject({ type: 'adjust', amount: -3, note: 'Broke a cup' });
  });

  it('a reason is optional', async () => {
    const { adjust, list } = await setup();
    await adjust(2);
    expect((await list())[0].note).toBeNull();
    await adjust(1, '   ');
    expect((await list())[0].note).toBeNull();
  });

  it('a reason that is not text or is too long is refused and nothing changes', async () => {
    const { adjust, list } = await setup();
    expect((await adjust(5, 12345)).statusCode).toBe(400);
    expect((await adjust(5, 'x'.repeat(201))).statusCode).toBe(400);
    expect(await list()).toHaveLength(0);
  });

  it('refused adjustments leave no row', async () => {
    const { adjust, list } = await setup();
    expect((await adjust(-100)).statusCode).toBe(400);
    expect((await adjust(0)).statusCode).toBe(400);
    expect(await list()).toHaveLength(0);
  });

  it('they are mixed in with charges, newest first', async () => {
    const { app, db, adjust, list } = await setup();
    const op = await makeOperator(app, db);
    await app.inject({ method: 'POST', url: '/charges', headers: auth(op.token), payload: { cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'a' } });
    await adjust(5, 'bonus');
    await app.inject({ method: 'POST', url: '/charges', headers: auth(op.token), payload: { cardUid: '04:A2:3B:1C', amount: 4, idempotencyKey: 'b' } });
    expect((await list()).map((r: { type: string; amount: number }) => [r.type, r.amount])).toEqual([['give', 4], ['adjust', 5], ['give', 8]]);
  });

  it('the limit applies to the combined list', async () => {
    const { adjust, list } = await setup();
    for (let i = 0; i < 4; i++) await adjust(1, `n${i}`);
    expect(await list(undefined, '?limit=3')).toHaveLength(3);
    expect((await list(undefined, '?limit=3'))[0].note).toBe('n3');
  });

  it('operators and phones never see them', async () => {
    const { app, db, adjust, list } = await setup();
    await adjust(5, 'secret');
    const op = await makeOperator(app, db);
    expect(await list(op.token)).toEqual([]);
    expect(await list(op.terminalToken)).toEqual([]);
  });

  it('the balance after each adjustment is kept', async () => {
    const { adjust, db } = await setup();
    await adjust(5); await adjust(-10);
    const rows = db.prepare('select delta, balance_after from balance_adjustments order by created_at').all();
    expect(rows).toEqual([{ delta: 5, balance_after: 51 }, { delta: -10, balance_after: 41 }]);
  });

  it('a card adjusted by an admin who has since been switched off still shows their name', async () => {
    const { app, adminToken, db, adjust, list } = await setup();
    const { seedStaff } = await import('../src/auth.js');
    const { login } = await import('./helpers.js');
    seedStaff(db, { name: 'Second Admin', email: 'two@pont.example', password: 'pw123456', role: 'admin' });
    const two = await login(app, 'two@pont.example', 'pw123456');
    const anna = (db.prepare('select id from cards').get() as { id: string });
    await app.inject({ method: 'POST', url: `/cards/${anna.id}/adjust`, headers: auth(two), payload: { delta: 2, reason: 'x' } });
    db.prepare("update staff set active=0 where email='two@pont.example'").run();
    expect((await list(adminToken))[0].operator).toBe('Second Admin');
    void adjust;
  });
});

describe('upgrading a database whose adjustments table is old', () => {
  it('adds the balance and reason columns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pont-adj-')), 'old.db');
    const old = new Database(path);
    old.exec("create table balance_adjustments(id text primary key, card_id text not null, delta integer not null, staff_id text, created_at text not null); insert into balance_adjustments values('a1','c1',5,'s1','2026-01-01T00:00:00.000Z');");
    old.close();
    const db = openDb(path);
    const cols = (db.prepare('pragma table_info(balance_adjustments)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['balance_after', 'reason']));
    expect((db.prepare("select balance_after, reason from balance_adjustments where id='a1'").get() as object)).toEqual({ balance_after: null, reason: null });
  });
});
