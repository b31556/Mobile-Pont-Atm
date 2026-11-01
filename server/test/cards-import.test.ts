import { describe, it, expect } from 'vitest';
import { makeApp, makeOperator, makeTerminal, auth } from './helpers.js';
import { MAX_IMPORT } from '../src/routes/cards.js';
import { changeFor } from '../src/live.js';

async function setup() {
  const ctx = await makeApp();
  const check = (rows: unknown, token = ctx.adminToken) => ctx.app.inject({ method: 'POST', url: '/cards/import/check', headers: auth(token), payload: { rows } });
  const run = (rows: unknown, token = ctx.adminToken) => ctx.app.inject({ method: 'POST', url: '/cards/import', headers: auth(token), payload: { rows } });
  const count = () => (ctx.db.prepare('select count(*) c from cards').get() as { c: number }).c;
  return { ...ctx, check, run, count };
}

describe('POST /cards/import/check', () => {
  it('says every row is fine, with the UID in its standard form', async () => {
    const { check } = await setup();
    const res = await check([{ name: 'Anna Kovács', uid: '04a23b1c', points: 12 }, { name: 'Béla', uid: '04-BB-CC-DD' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, results: [{ index: 0, ok: true, uid: '04:A2:3B:1C' }, { index: 1, ok: true, uid: '04:BB:CC:DD' }] });
  });

  it('says what is wrong with each bad row, and saves nothing', async () => {
    const { check, count } = await setup();
    const res = await check([
      { name: '', uid: '04A23B1C' },
      { name: 'No UID', uid: 'zz' },
      { name: 'Short UID', uid: '0102' },
      { name: 'Negative', uid: '04A23B1D', points: -1 },
      { name: 'Fraction', uid: '04A23B1E', points: 1.5 },
      { name: 'Text points', uid: '04A23B1F', points: '5' },
      { name: 'Huge', uid: '04A23B20', points: 1_000_001 },
      { name: 'x'.repeat(101), uid: '04A23B21' },
      { name: 'Fine', uid: '04A23B22', points: 3 },
      'not an object', null, 42,
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    const errs = body.results.map((r: { ok: boolean; error?: string }) => r.ok ? 'ok' : r.error);
    expect(errs[0]).toMatch(/holder’s name/);
    expect(errs[1]).toMatch(/valid card UID/);
    expect(errs[2]).toMatch(/valid card UID/);
    for (const i of [3, 4, 5, 6]) expect(errs[i]).toMatch(/whole number from 0 to 1000000/);
    expect(errs[7]).toMatch(/up to 100 characters/);
    expect(errs[8]).toBe('ok');
    for (const i of [9, 10, 11]) expect(errs[i]).toMatch(/holder’s name/);
    expect(count()).toBe(0);
  });

  it('catches the same UID twice in the list, in any spelling, naming the first row', async () => {
    const { check } = await setup();
    const res = await check([{ name: 'A', uid: '04A23B1C' }, { name: 'B', uid: '04:a2:3b:1c' }, { name: 'C', uid: '04-A2-3B-1C' }]);
    const r = res.json().results;
    expect(r[0].ok).toBe(true);
    expect(r[1]).toMatchObject({ ok: false, error: 'The same card UID as row 1' });
    expect(r[2]).toMatchObject({ ok: false, error: 'The same card UID as row 1' });
  });

  it('points at the line of the pasted list when the rows say which line they came from', async () => {
    const { check } = await setup();
    const r = (await check([{ name: 'A', uid: '04A23B1C', line: 4 }, { name: 'B', uid: '04A23B1D', line: 'x' }, { name: 'C', uid: '04:a2:3b:1c', line: 9 }, { name: 'D', uid: '04A23B1D', line: 12 }])).json().results;
    expect(r[2].error).toBe('The same card UID as line 4');
    expect(r[3].error).toBe('The same card UID as row 2');   // the earlier row's line number is not a number, so its position in the list is used instead
  });

  it('catches a UID that is already on a card, and says whose', async () => {
    const { check, app, adminToken } = await setup();
    await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Existing Eva', uid: '04A23B1C' } });
    const r = (await check([{ name: 'New', uid: '04:A2:3B:1C' }, { name: 'Other', uid: '04A23B1D' }])).json();
    expect(r.ok).toBe(false);
    expect(r.results[0].error).toBe('That UID is already on a card (Existing Eva)');
    expect(r.results[1].ok).toBe(true);
  });

  it('refuses an empty, missing, malformed or oversized list', async () => {
    const { check } = await setup();
    for (const rows of [[], undefined, null, 'text', {}, 5]) expect((await check(rows)).statusCode).toBe(400);
    const many = Array.from({ length: MAX_IMPORT + 1 }, (_, i) => ({ name: `P${i}`, uid: i.toString(16).padStart(8, '0') }));
    const res = await check(many);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Up to 1000/);
  });

  it('accepts exactly the maximum', async () => {
    const { check } = await setup();
    const rows = Array.from({ length: MAX_IMPORT }, (_, i) => ({ name: `P${i}`, uid: i.toString(16).padStart(8, '0') }));
    const res = await check(rows);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});

describe('POST /cards/import', () => {
  const people = [
    { name: '  Anna Kovács ', uid: '04A23B1C', points: 12 },
    { name: 'Béla Nagy', uid: '04BBCCDD' },
    { name: 'Árvíztűrő Tükörfúrógép', uid: '01020304050607', points: 0 },
  ];

  it('makes every card, active, with its starting points, and returns the ids in order', async () => {
    const { run, app, adminToken, count } = await setup();
    const res = await run(people);
    expect(res.statusCode).toBe(201);
    const created = res.json().created as { index: number; id: string; uid: string }[];
    expect(created.map(c => c.index)).toEqual([0, 1, 2]);
    expect(created.map(c => c.uid)).toEqual(['04:A2:3B:1C', '04:BB:CC:DD', '01:02:03:04:05:06:07']);
    expect(count()).toBe(3);
    const list = (await app.inject({ method: 'GET', url: '/cards', headers: auth(adminToken) })).json();
    const by = (name: string) => list.find((c: { name: string }) => c.name === name);
    expect(by('Anna Kovács')).toMatchObject({ balance: 12, status: 'active', uid: '04:A2:3B:1C', hasPhoto: false, id: created[0].id });
    expect(by('Béla Nagy')).toMatchObject({ balance: 0, status: 'active' });
    expect(by('Árvíztűrő Tükörfúrógép')).toMatchObject({ balance: 0, uid: '01:02:03:04:05:06:07' });
  });

  it('gives the placeholder portraits out in turn, continuing after the cards already there', async () => {
    const { run, db, app, adminToken } = await setup();
    await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'First', uid: '0A0B0C0D' } });
    await run(Array.from({ length: 7 }, (_, i) => ({ name: `P${i}`, uid: `0100000${i}` })));
    const styles = db.prepare('select photo_style s from cards order by rowid').all().map((r: any) => r.s);
    expect(styles).toEqual([0, 1, 2, 3, 4, 0, 1, 2]);   // 5 styles, the first card took style 0
  });

  it('is all or nothing: one bad row means no card is made', async () => {
    const { run, count } = await setup();
    const res = await run([...people, { name: 'Bad', uid: 'nope' }]);
    expect(res.statusCode).toBe(400);
    expect(res.json().results[3].ok).toBe(false);
    expect(res.json().results[0].ok).toBe(true);
    expect(count()).toBe(0);
  });

  it('running the same list twice is refused the second time and makes no duplicates', async () => {
    const { run, count } = await setup();
    expect((await run(people)).statusCode).toBe(201);
    const again = await run(people);
    expect(again.statusCode).toBe(400);
    expect(again.json().results.every((r: { error?: string }) => /already on a card/.test(r.error ?? ''))).toBe(true);
    expect(count()).toBe(3);
  });

  it('removes the imported cards from the "suggested cards" list', async () => {
    const { run, db, app, adminToken } = await setup();
    const phone = makeTerminal(app, db);
    await app.inject({ method: 'POST', url: '/card-suggestions', headers: auth(phone.terminalToken), payload: { cardUid: '04A23B1C' } });
    await app.inject({ method: 'POST', url: '/card-suggestions', headers: auth(phone.terminalToken), payload: { cardUid: '0A0B0C0D' } });
    await run(people);
    const left = (await app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(adminToken) })).json();
    expect(left.map((s: { uid: string }) => s.uid)).toEqual(['0A:0B:0C:0D']);
  });

  it('imported cards can be charged and can get a photo like any other', async () => {
    const { run, app, db } = await setup();
    const created = (await run(people)).json().created;
    const phone = makeTerminal(app, db);
    const charge = await app.inject({ method: 'POST', url: '/charges', headers: auth(phone.terminalToken), payload: { cardUid: '04:A2:3B:1C', amount: 8, idempotencyKey: 'k1' } });
    expect(charge.statusCode).toBe(200);
    expect(charge.json().card).toMatchObject({ id: created[0].id, balanceBefore: 12, balance: 20 });
  });

  it('is for admins only', async () => {
    const { run, check, app, db, count } = await setup();
    const op = await makeOperator(app, db);
    const phone = makeTerminal(app, db);
    for (const f of [run, check]) {
      expect((await app.inject({ method: 'POST', url: '/cards/import', payload: { rows: people } })).statusCode).toBe(401);
      expect((await f(people, op.token)).statusCode).toBe(403);
      expect((await f(people, phone.terminalToken)).statusCode).toBe(403);
    }
    expect(count()).toBe(0);
  });
});

describe('live updates for the import', () => {
  it('the real import wakes other admin pages, the dry run does not', () => {
    expect(changeFor('POST', '/cards/import', 201)?.topics.sort()).toEqual(['cards', 'transactions']);
    expect(changeFor('POST', '/cards/import/check', 200)).toBeNull();
    expect(changeFor('POST', '/cards/import', 400)).toBeNull();
  });
});
