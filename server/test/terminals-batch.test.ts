import { describe, it, expect } from 'vitest';
import { makeApp, makeTerminal, auth, makeOperator } from './helpers.js';
import { parseTerminalLines, MAX_BATCH } from '../src/batch.js';

const EXAMPLE = `Floorball Terminal 1
Floorball Terminal 2
Checkin Anna's Terminal`;

describe('parsing the group list', () => {
  const ok = (t: string) => { const r = parseTerminalLines(t); if (!r.ok) throw new Error(r.error); return r.rows; };
  const err = (t: unknown) => { const r = parseTerminalLines(t); if (r.ok) throw new Error('expected an error'); return r.error; };

  it('the first word is the place, the rest is the terminal name', () => {
    expect(ok(EXAMPLE)).toEqual([
      { place: 'Floorball', name: 'Terminal 1' }, { place: 'Floorball', name: 'Terminal 2' }, { place: 'Checkin', name: "Anna's Terminal" },
    ]);
  });
  it('skips blank lines and copes with Windows line endings and extra spaces', () => {
    expect(ok('\r\n  Bar    Terminal   1  \r\n\r\n\nBar Terminal 2\r\n')).toEqual([{ place: 'Bar', name: 'Terminal   1' }, { place: 'Bar', name: 'Terminal 2' }]);
  });
  it('a tab or a | lets the place have several words', () => {
    expect(ok('Main hall\tBar 2\nMain hall | Bar 3\nEntrance|Door')).toEqual([
      { place: 'Main hall', name: 'Bar 2' }, { place: 'Main hall', name: 'Bar 3' }, { place: 'Entrance', name: 'Door' },
    ]);
  });
  it('names the line with a problem', () => {
    expect(err('Bar Terminal 1\nLonely\nBar Terminal 3')).toMatch(/^Line 2:/);
    expect(err('Bar | ')).toMatch(/^Line 1:/);
  });
  it('rejects the same terminal twice, ignoring case', () => {
    expect(err('Bar T1\nbar t1')).toMatch(/Line 2.*twice/);
  });
  it('rejects empty, too long, too many, odd characters and non-text', () => {
    expect(err('  \n \n')).toMatch(/empty/);
    expect(err(`Bar ${'x'.repeat(61)}`)).toMatch(/60 characters/);
    expect(err(Array.from({ length: MAX_BATCH + 1 }, (_, i) => `P T${i}`).join('\n'))).toMatch(/Up to 100/);
    expect(err('Bar T\u0001')).toMatch(/can't be used/);
    for (const bad of [undefined, null, 5, {}, ['a b']]) expect(err(bad)).toMatch(/Paste the list/);
    expect(err('a '.repeat(20_000))).toMatch(/too long/);
  });
  it('allows exactly the maximum', () => {
    expect(ok(Array.from({ length: MAX_BATCH }, (_, i) => `P T${i}`).join('\n'))).toHaveLength(MAX_BATCH);
  });
});

describe('POST /terminals/batch', () => {
  const post = (app: any, token: string, body: object) => app.inject({ method: 'POST', url: '/terminals/batch', headers: auth(token), payload: body });
  const base = { text: EXAMPLE, mode: 'atm', expiresInMinutes: 60 };
  const count = (db: any) => (db.prepare('select count(*) c from terminals').get() as { c: number }).c;

  it('creates a phone with its own pairing code for every line', async () => {
    const { app, db, adminToken } = await makeApp();
    const res = await post(app, adminToken, base);
    expect(res.statusCode).toBe(201);
    const { terminals, expiresAt } = res.json();
    expect(terminals.map((t: any) => [t.place, t.name])).toEqual([['Floorball', 'Terminal 1'], ['Floorball', 'Terminal 2'], ['Checkin', "Anna's Terminal"]]);
    const codes = terminals.map((t: any) => t.pairingCode);
    expect(codes.every((c: string) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(3);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    const rows = db.prepare("select name, place, mode, kind, active, charge_limit_hour l from terminals where place in ('Floorball','Checkin') order by name").all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.mode === 'atm' && r.kind === 'phone' && r.active === 1 && r.l === 5000)).toBe(true);
  });

  it('every code pairs its own terminal, and the phone then works', async () => {
    const { app, db, adminToken } = await makeApp();
    const { terminals } = (await post(app, adminToken, base)).json();
    const card = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'A', uid: '04A23B1C' } })).json();
    for (const t of terminals) {
      const pair = await app.inject({ method: 'POST', url: '/pair', payload: { code: t.pairingCode, device: 'x', appVersion: '1' } });
      expect(pair.statusCode).toBe(200);
      expect(pair.json().terminal).toMatchObject({ id: t.id, name: t.name });
      const charge = await app.inject({ method: 'POST', url: '/charges', headers: auth(pair.json().terminalToken), payload: { cardUid: '04:A2:3B:1C', amount: 5, idempotencyKey: `k-${t.id}` } });
      expect(charge.statusCode).toBe(200);
      expect(charge.json().transaction.terminal).toBe(t.name);
    }
    expect((db.prepare('select balance b from cards where id=?').get(card.id) as { b: number }).b).toBe(15);
  });

  it('the codes expire after the chosen time, not the old fixed 10 minutes', async () => {
    const { app, db, adminToken } = await makeApp();
    const day = (await post(app, adminToken, { ...base, text: 'Bar Day', expiresInMinutes: 24 * 60 })).json().terminals[0];
    const short = (await post(app, adminToken, { ...base, text: 'Bar Short', expiresInMinutes: 5 })).json().terminals[0];
    const exp = (code: string) => (db.prepare('select expires_at e from pairing_codes where code=?').get(code) as { e: number }).e - Date.now();
    expect(exp(day.pairingCode)).toBeGreaterThan(23.9 * 3600_000);
    expect(exp(short.pairingCode)).toBeLessThanOrEqual(5 * 60_000);
    db.prepare('update pairing_codes set expires_at=? where code=?').run(Date.now() - 1, short.pairingCode);
    const late = await app.inject({ method: 'POST', url: '/pair', payload: { code: short.pairingCode } });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toMatch(/expired/);
    expect((await app.inject({ method: 'POST', url: '/pair', payload: { code: day.pairingCode } })).statusCode).toBe(200);
  });

  it('check-in mode sets the zone and the direction (toggle by default, default zone by default)', async () => {
    const { app, db, adminToken } = await makeApp();
    const zone = (await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym' } })).json();
    const a = (await post(app, adminToken, { ...base, text: 'Door In', mode: 'presence', zoneId: zone.id, direction: 'in' })).json().terminals[0];
    const b = (await post(app, adminToken, { ...base, text: 'Door Plain', mode: 'presence' })).json().terminals[0];
    const row = (id: string) => db.prepare('select mode, zone_id z, direction d from terminals where id=?').get(id) as any;
    expect(row(a.id)).toEqual({ mode: 'presence', z: zone.id, d: 'in' });
    const def = (db.prepare('select id from zones order by created_at, rowid limit 1').get() as { id: string }).id;
    expect(row(b.id)).toEqual({ mode: 'presence', z: def, d: 'toggle' });
  });

  it('an ATM batch ignores zone and direction', async () => {
    const { app, db, adminToken } = await makeApp();
    const t = (await post(app, adminToken, { ...base, text: 'Bar One', zoneId: 'nope', direction: 'bogus' })).json().terminals[0];
    expect(db.prepare('select zone_id z, direction d from terminals where id=?').get(t.id)).toEqual({ z: null, d: 'toggle' });
  });

  it('shows up in the terminal list with its place and mode', async () => {
    const { app, adminToken } = await makeApp();
    await post(app, adminToken, { ...base, mode: 'presence' });
    const list = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(list.filter((t: any) => t.place === 'Floorball' && t.mode === 'presence')).toHaveLength(2);
  });

  it('creates nothing when anything is wrong (all or nothing)', async () => {
    const { app, db, adminToken } = await makeApp();
    const before = count(db);
    const cases: [object, number][] = [
      [{ ...base, text: 'Bar T1\nLonely' }, 400],
      [{ ...base, text: '' }, 400],
      [{ ...base, mode: 'fixed' }, 400],
      [{ ...base, mode: undefined }, 400],
      [{ ...base, mode: 'presence', zoneId: 'no-such-zone' }, 404],
      [{ ...base, mode: 'presence', zoneId: 5 }, 400],
      [{ ...base, mode: 'presence', direction: 'sideways' }, 400],
    ];
    for (const [body, status] of cases) expect((await post(app, adminToken, body)).statusCode).toBe(status);
    expect(count(db)).toBe(before);
    expect((db.prepare('select count(*) c from pairing_codes').get() as { c: number }).c).toBe(0);
  });

  it('only accepts an expiry from 1 minute to 7 days', async () => {
    const { app, adminToken } = await makeApp();
    for (const bad of [0, -1, 1.5, 10081, '60', null, undefined, NaN]) expect((await post(app, adminToken, { ...base, expiresInMinutes: bad })).statusCode).toBe(400);
    for (const good of [1, 10080]) expect((await post(app, adminToken, { ...base, text: `P T${good}`, expiresInMinutes: good })).statusCode).toBe(201);
  });

  it('is for admins only', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    const phone = makeTerminal(app, db);
    expect((await app.inject({ method: 'POST', url: '/terminals/batch', payload: base })).statusCode).toBe(401);
    expect((await post(app, op.token, base)).statusCode).toBe(403);
    expect((await post(app, phone.terminalToken, base)).statusCode).toBe(403);
  });
});
