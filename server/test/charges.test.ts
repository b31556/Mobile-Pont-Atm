import { describe, it, expect } from 'vitest';
import { makeApp, auth, makeOperator } from './helpers.js';

async function setup() {
  const ctx = await makeApp();
  const op = await makeOperator(ctx.app, ctx.db);
  const mk = async (name: string, uid: string, points = 0) =>
    (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name, uid, points } })).json();
  const anna = await mk('Anna Kovács', '04A23B1C', 46);
  const charge = (body: object, token = op.token) =>
    ctx.app.inject({ method: 'POST', url: '/charges', headers: auth(token), payload: body });
  const balance = (id: string) => (ctx.db.prepare('select balance from cards where id=?').get(id) as { balance: number }).balance;
  const rows = () => (ctx.db.prepare('select count(*) c from transactions').get() as { c: number }).c;
  return { ...ctx, op, anna, mk, charge, balance, rows };
}

describe('POST /charges', () => {
  it('credits the card and returns holder, photo url and balances', async () => {
    const { anna, charge, balance } = await setup();
    const res = await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'k1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.card).toMatchObject({ id: anna.id, name: 'Anna Kovács', balanceBefore: 46, balance: 54, photoUrl: `/cards/${anna.id}/photo` });
    expect(body.transaction).toMatchObject({ amount: 8, terminal: 'Bar 2' });
    expect(balance(anna.id)).toBe(54);
  });

  it('the same idempotency key returns the original result and credits once', async () => {
    const { anna, charge, balance, rows } = await setup();
    const a = await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'same' });
    const b = await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'same' });
    expect(b.statusCode).toBe(200);
    expect(b.json().transaction.id).toBe(a.json().transaction.id);
    expect(b.json().card).toMatchObject({ balanceBefore: 46, balance: 54 });
    expect(balance(anna.id)).toBe(54);
    expect(rows()).toBe(1);
  });

  it('reusing a key for a different amount is a 409 and credits nothing', async () => {
    const { anna, charge, balance } = await setup();
    await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'k' });
    const res = await charge({ cardUid: '04:A2:3B:1C', amount: 9, idempotencyKey: 'k' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('key_reused');
    expect(balance(anna.id)).toBe(54);
  });

  it('two parallel charges add up', async () => {
    const { mk, charge, balance } = await setup();
    const c = await mk('Zero', '04112233', 0);
    const [r1, r2] = await Promise.all([
      charge({ cardUid: '04:11:22:33', amount: 5, idempotencyKey: 'p1' }),
      charge({ cardUid: '04:11:22:33', amount: 7, idempotencyKey: 'p2' }),
    ]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect(balance(c.id)).toBe(12);
  });

  it('a blocked card is refused with 403 card_blocked and nothing changes', async () => {
    const { app, adminToken, anna, charge, balance, rows } = await setup();
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    const res = await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'b' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'card_blocked', card: { name: 'Anna Kovács', photoUrl: `/cards/${anna.id}/photo` } });
    expect(balance(anna.id)).toBe(46);
    expect(rows()).toBe(0);
  });

  it('an unknown UID is 404 unknown_card', async () => {
    const { charge, rows } = await setup();
    const res = await charge({ cardUid: '04:EE:00:77', amount: 8, idempotencyKey: 'u' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('unknown_card');
    expect(rows()).toBe(0);
  });

  it('lowercase and unseparated UIDs find the same card', async () => {
    const { anna, charge } = await setup();
    const res = await charge({ cardUid: '04a23b1c', amount: 1, idempotencyKey: 'f' });
    expect(res.json().card.id).toBe(anna.id);
  });

  it.each([0, -3, 10000, 1.5, '8', null])('amount %s is 400 bad_amount', async amount => {
    const { charge, balance, anna } = await setup();
    const res = await charge({ cardUid: '04:A2:3B:1C', amount, idempotencyKey: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_amount');
    expect(balance(anna.id)).toBe(46);
  });

  it('a missing idempotency key is 400', async () => {
    const { charge } = await setup();
    expect((await charge({ cardUid: '04:A2:3B:1C', amount: 8 })).statusCode).toBe(400);
  });

  it('admins cannot charge (operators only)', async () => {
    const { charge, adminToken } = await setup();
    expect((await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'a' }, adminToken)).statusCode).toBe(403);
  });
});

describe('storno', () => {
  async function charged() {
    const s = await setup();
    const res = await s.charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'k' });
    return { ...s, txId: res.json().transaction.id as number };
  }
  const storno = (app: any, token: string, id: number) =>
    app.inject({ method: 'POST', url: `/transactions/${id}/storno`, headers: auth(token) });

  it('restores the balance, marks the original stornoed and adds one reversing row', async () => {
    const { app, op, anna, txId, balance, db } = await charged();
    const res = await storno(app, op.token, txId);
    expect(res.statusCode).toBe(200);
    expect(res.json().card.balance).toBe(46);
    expect(balance(anna.id)).toBe(46);
    const orig = db.prepare('select status from transactions where id=?').get(txId) as any;
    expect(orig.status).toBe('stornoed');
    const rev = db.prepare("select * from transactions where type='storno'").all() as any[];
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ amount: -8, ref: txId, card_id: anna.id });
  });

  it('stornoing twice is 400 already_stornoed and changes nothing', async () => {
    const { app, op, txId, anna, balance } = await charged();
    await storno(app, op.token, txId);
    const again = await storno(app, op.token, txId);
    expect(again.statusCode).toBe(400);
    expect(again.json().code).toBe('already_stornoed');
    expect(balance(anna.id)).toBe(46);
  });

  it('stornoing a storno row is 400 not_a_charge', async () => {
    const { app, op, txId, db } = await charged();
    await storno(app, op.token, txId);
    const revId = (db.prepare("select id from transactions where type='storno'").get() as any).id;
    const res = await storno(app, op.token, revId);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('not_a_charge');
  });

  it('refuses when the card has fewer points than the storno', async () => {
    const { app, op, txId, anna, db, balance } = await charged();
    db.prepare('update cards set balance=3 where id=?').run(anna.id);
    const res = await storno(app, op.token, txId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'would_go_negative', error: 'Card has fewer points than this storno.' });
    expect(balance(anna.id)).toBe(3);
    expect((db.prepare('select status from transactions where id=?').get(txId) as any).status).toBe('ok');
  });

  it('a blocked card can still be stornoed', async () => {
    const { app, adminToken, op, anna, txId } = await charged();
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    expect((await storno(app, op.token, txId)).statusCode).toBe(200);
  });

  it('an operator cannot storno another terminal’s charge, an admin can', async () => {
    const { app, adminToken, db, txId } = await charged();
    const other = await makeOperator(app, db, 'mark@pont.example', 'Entrance');
    expect((await storno(app, other.token, txId)).statusCode).toBe(403);
    expect((await storno(app, adminToken, txId)).statusCode).toBe(200);
  });

  it('unknown transaction is 404', async () => {
    const { app, op } = await charged();
    expect((await storno(app, op.token, 99999)).statusCode).toBe(404);
  });
});

describe('GET /transactions', () => {
  it('an operator sees only their terminal, newest first, including storno rows', async () => {
    const { app, db, op, charge, anna, adminToken } = await setup();
    const other = await makeOperator(app, db, 'mark@pont.example', 'Entrance');
    const first = await charge({ cardUid: '04:A2:3B:1C', amount: 4, idempotencyKey: 'a' });
    await charge({ cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'b' }, op.token);
    await app.inject({ method: 'POST', url: '/charges', headers: auth(other.token), payload: { cardUid: '04:A2:3B:1C', amount: 20, idempotencyKey: 'c' } });
    await app.inject({ method: 'POST', url: `/transactions/${first.json().transaction.id}/storno`, headers: auth(op.token) });
    const mine = (await app.inject({ method: 'GET', url: '/transactions', headers: auth(op.token) })).json();
    expect(mine.map((t: any) => [t.type, t.amount])).toEqual([['storno', -4], ['give', 8], ['give', 4]]);
    expect(mine[1]).toMatchObject({ terminal: 'Bar 2', operator: 'Eszter', card: { id: anna.id, name: 'Anna Kovács' } });
    expect(mine.find((t: any) => t.amount === 4).status).toBe('stornoed');
    const sneaky = (await app.inject({ method: 'GET', url: '/transactions?terminal=all', headers: auth(op.token) })).json();
    expect(sneaky).toHaveLength(3);
    const all = (await app.inject({ method: 'GET', url: '/transactions', headers: auth(adminToken) })).json();
    expect(all).toHaveLength(4);
  });

  it('respects limit', async () => {
    const { app, op, charge } = await setup();
    for (let i = 0; i < 3; i++) await charge({ cardUid: '04:A2:3B:1C', amount: 1, idempotencyKey: `k${i}` });
    const res = (await app.inject({ method: 'GET', url: '/transactions?limit=2', headers: auth(op.token) })).json();
    expect(res).toHaveLength(2);
  });
});
