import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedStaff } from '../src/auth.js';
import { ago, historyLine, eventFor } from '../src/display.js';
import { auth, login, makeReader, makeTerminal } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function setup(extra: { dataDir?: string } = {}) {
  const dataDir = extra.dataDir ?? mkdtempSync(join(tmpdir(), 'pont-'));
  const db = openDb(':memory:');
  const app = buildApp({ db, jwtSecret: 'a-test-secret-that-is-long-enough-0123456789', dataDir });
  await app.ready();
  seedStaff(db, { name: 'Admin', email: 'admin@pont.example', password: 'adminpass', role: 'admin' });
  const adminToken = await login(app, 'admin@pont.example', 'adminpass');
  const card = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Anna Kovács', uid: '04A23B1C', points: 20 } })).json();
  const phone = makeTerminal(app, db, 'Bar 2');
  const setMode = (terminalId: string, mode: string) => app.inject({ method: 'PATCH', url: `/terminals/${terminalId}`, headers: auth(adminToken), payload: { mode } });
  return { app, db, dataDir, adminToken, card, phone, setMode };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Gives the card one of each kind of history, oldest first. */
function seedHistory(c: Ctx) {
  const t0 = Date.now() - 6 * 3600_000;
  const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
  const zone = (c.db.prepare('select id from zones limit 1').get() as { id: string }).id;
  const ins = c.db.prepare(`insert into transactions(card_id,amount,type,status,terminal_id,created_at,balance_after,kind,note,zone_id) values(?,?,?,?,?,?,?,?,?,?)`);
  ins.run(c.card.id, 8, 'give', 'ok', c.phone.terminalId, at(1), 28, 'atm', null, null);
  ins.run(c.card.id, 5, 'give', 'stornoed', c.phone.terminalId, at(2), 33, 'atm', null, null);
  ins.run(c.card.id, -5, 'storno', 'ok', c.phone.terminalId, at(3), 28, 'atm', null, null);
  ins.run(c.card.id, 10, 'give', 'ok', c.phone.terminalId, at(4), 38, 'fixed', null, null);
  ins.run(c.card.id, 12, 'give', 'ok', c.phone.terminalId, at(5), 50, 'presence', '34 min', zone);
  c.db.prepare('insert into balance_adjustments(id,card_id,delta,staff_id,created_at,balance_after,reason) values(?,?,?,?,?,?,?)').run('adj1', c.card.id, -3, null, at(6), 47, 'Lost wristband');
}

describe('info kiosk: POST /info/tap', () => {
  const tap = (c: Ctx, body: object, token = c.phone.terminalToken) => c.app.inject({ method: 'POST', url: '/info/tap', headers: auth(token), payload: body });

  it('shows the card and its history and changes nothing', async () => {
    const c = await setup();
    seedHistory(c);
    await c.setMode(c.phone.terminalId, 'info');
    const before = c.db.prepare('select balance, last_used from cards where id=?').get(c.card.id);
    const txBefore = (c.db.prepare('select count(*) n from transactions').get() as { n: number }).n;
    const res = await tap(c, { cardUid: '04:a2:3b:1c' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.action).toBe('info');
    expect(b.card).toEqual({ id: c.card.id, name: 'Anna Kovács', photoUrl: `/cards/${c.card.id}/photo`, balance: 20 });
    expect(b.history.map((h: { kind: string }) => h.kind)).toEqual(['adjust', 'presence', 'fixed', 'storno', 'atm', 'atm']);   // newest first
    expect(c.db.prepare('select balance, last_used from cards where id=?').get(c.card.id)).toEqual(before);
    expect((c.db.prepare('select count(*) n from transactions').get() as { n: number }).n).toBe(txBefore);
  });

  it('describes each kind of history item', async () => {
    const c = await setup();
    seedHistory(c);
    await c.setMode(c.phone.terminalId, 'info');
    const h = (await tap(c, { cardUid: '04A23B1C' })).json().history;
    expect(h[0]).toMatchObject({ kind: 'adjust', amount: -3, place: '', note: 'Lost wristband', stornoed: false });
    expect(h[1]).toMatchObject({ kind: 'presence', amount: 12, place: 'Main area', note: '34 min' });   // a check-out is named for the zone
    expect(h[2]).toMatchObject({ kind: 'fixed', amount: 10, place: 'Bar 2', note: null });
    expect(h[3]).toMatchObject({ kind: 'storno', amount: -5, place: 'Bar 2' });
    expect(h[4]).toMatchObject({ kind: 'atm', amount: 5, stornoed: true });
    expect(h[5]).toMatchObject({ kind: 'atm', amount: 8, stornoed: false });
  });

  it('is refused by a terminal that is not an info kiosk', async () => {
    const c = await setup();
    const res = await tap(c, { cardUid: '04A23B1C' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wrong_mode');
  });

  it('an unknown card is a 404 and goes to the suggestions, a blocked one a 403', async () => {
    const c = await setup();
    await c.setMode(c.phone.terminalId, 'info');
    const unknown = await tap(c, { cardUid: '04:00:00:01' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('unknown_card');
    const sugg = (await c.app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(c.adminToken) })).json();
    expect(sugg.map((s: { uid: string }) => s.uid)).toEqual(['04:00:00:01']);
    await c.app.inject({ method: 'PATCH', url: `/cards/${c.card.id}`, headers: auth(c.adminToken), payload: { status: 'blocked' } });
    const blocked = await tap(c, { cardUid: '04A23B1C' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'card_blocked', card: { name: 'Anna Kovács' } });
    expect((await tap(c, { cardUid: 'junk' })).statusCode).toBe(404);
  });

  it('needs a terminal or operator sign-in', async () => {
    const c = await setup();
    expect((await c.app.inject({ method: 'POST', url: '/info/tap', payload: { cardUid: '04A23B1C' } })).statusCode).toBe(401);
    expect((await tap(c, { cardUid: '04A23B1C' }, c.adminToken)).statusCode).toBe(403);
  });

  it('puts the points and the latest history on the terminal’s display page', async () => {
    const c = await setup();
    seedHistory(c);
    await c.setMode(c.phone.terminalId, 'info');
    await tap(c, { cardUid: '04A23B1C' });
    const e = c.app.displayHub.last(c.phone.terminalId)!;
    expect(e.headline).toBe('20 points');
    expect(e.balance).toBeNull();
    expect(e.card).toEqual({ id: c.card.id, name: 'Anna Kovács' });
    expect(e.details).toHaveLength(5);
    expect(e.details[0]).toMatch(/^−3 · Adjustment · Lost wristband · \d+ (minutes?|hours?) ago$/);
    expect(e.details[1]).toMatch(/^\+12 · Check-out · Main area · 34 min · /);
    expect(e.tone).toBe('good');
  });

  it('shows the same refusals on the display as the other modes', async () => {
    const c = await setup();
    await c.setMode(c.phone.terminalId, 'info');
    await tap(c, { cardUid: '04:00:00:01' });
    expect(c.app.displayHub.last(c.phone.terminalId)).toMatchObject({ tone: 'refused', headline: 'Card not registered' });
  });
});

describe('info kiosk: setting the mode', () => {
  it('a phone and a reader can be info kiosks, other modes still checked', async () => {
    const c = await setup();
    const reader = await makeReader(c.app, c.adminToken);
    expect((await c.setMode(c.phone.terminalId, 'info')).statusCode).toBe(200);
    expect((await c.setMode(reader.terminalId, 'info')).statusCode).toBe(200);
    expect((await c.setMode(reader.terminalId, 'atm')).statusCode).toBe(400);   // a reader is never an ATM
    expect((await c.setMode(c.phone.terminalId, 'fixed')).statusCode).toBe(400);   // a phone is never a fixed-amount reader
    expect((await c.setMode(c.phone.terminalId, 'bogus')).statusCode).toBe(400);
    const cfg = await c.app.inject({ method: 'GET', url: '/terminal/config', headers: auth(c.phone.terminalToken) });
    expect(cfg.json().mode).toBe('info');
  });

  it('a new reader can be approved straight into info mode and then taps it', async () => {
    const c = await setup();
    const reader = await makeReader(c.app, c.adminToken, { mode: 'info' as 'fixed' });
    expect((await reader.hello()).json().mode).toBe('info');
    const res = await c.app.inject({ method: 'POST', url: '/info/tap', headers: auth(reader.terminalToken), payload: { cardUid: '04A23B1C' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().card.balance).toBe(20);
  });

  it('many phones can be made as info kiosks at once', async () => {
    const c = await setup();
    const res = await c.app.inject({ method: 'POST', url: '/terminals/batch', headers: auth(c.adminToken), payload: { text: 'Lobby Kiosk 1\nLobby Kiosk 2', mode: 'info', expiresInMinutes: 60 } });
    expect(res.statusCode).toBe(201);
    const rows = c.db.prepare("select mode, zone_id z from terminals where place='Lobby'").all();
    expect(rows).toEqual([{ mode: 'info', z: null }, { mode: 'info', z: null }]);
  });
});

describe('the words under a card on a display', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  it('says how long ago, without a clock time', () => {
    expect(ago('2026-11-01T11:59:50Z', now)).toBe('just now');
    expect(ago('2026-11-01T11:59:00Z', now)).toBe('1 minute ago');
    expect(ago('2026-11-01T11:15:00Z', now)).toBe('45 minutes ago');
    expect(ago('2026-11-01T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-10-31T11:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-10-28T12:00:00Z', now)).toBe('4 days ago');
    expect(ago('2026-11-01T13:00:00Z', now)).toBe('just now');   // a clock a little ahead is not "in the future"
    expect(ago(undefined, now)).toBe('');
    expect(ago('nonsense', now)).toBe('');
  });
  it('writes one line per item', () => {
    expect(historyLine({ at: '2026-11-01T11:55:00Z', kind: 'fixed', amount: 8, place: 'Bar 2' }, now)).toBe('+8 · Bar 2 · 5 minutes ago');
    expect(historyLine({ at: '2026-11-01T11:00:00Z', kind: 'presence', amount: 12, place: 'Main area', note: '34 min' }, now)).toBe('+12 · Check-out · Main area · 34 min · 1 hour ago');
    expect(historyLine({ at: '2026-11-01T11:00:00Z', kind: 'storno', amount: -5, place: 'Bar 2' }, now)).toBe('−5 · Refund · Bar 2 · 1 hour ago');
    expect(historyLine({ at: '2026-11-01T11:00:00Z', kind: 'adjust', amount: 3, place: '', note: 'Prize' }, now)).toBe('+3 · Adjustment · Prize · 1 hour ago');
    expect(historyLine({ at: '2026-11-01T11:55:00Z', kind: 'atm', amount: 5, place: 'Bar 2', stornoed: true }, now)).toBe('Reversed: +5 · Bar 2 · 5 minutes ago');
  });
  it('an info answer that is not an info answer shows nothing', () => {
    expect(eventFor({ status: 200, body: { action: 'granted', card: { id: 'x', name: 'A', balance: 1 } } }, 'info')).toBeNull();
  });
});

describe('POST /public/cards (the Pont Card app)', () => {
  const ask = (c: Ctx, uids: unknown, remoteAddress?: string) => c.app.inject({ method: 'POST', url: '/public/cards', remoteAddress, payload: { uids } });

  it('needs no sign-in and shows the holder their card, points and history', async () => {
    const c = await setup();
    seedHistory(c);
    const res = await ask(c, ['04-a2-3b-1c']);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const card = res.json().cards[0];
    expect(card).toMatchObject({ uid: '04:A2:3B:1C', found: true, name: 'Anna Kovács', status: 'active', balance: 20, photo: null });
    expect(card.history).toHaveLength(6);
    expect(card.history[0]).toMatchObject({ kind: 'adjust', note: 'Lost wristband' });
  });

  it('never gives out an internal id', async () => {
    const c = await setup();
    seedHistory(c);
    const text = (await ask(c, ['04A23B1C'])).body;
    expect(text).not.toContain(c.card.id);
    expect(text).not.toContain(c.phone.terminalId);
    expect(Object.keys(JSON.parse(text).cards[0]).sort()).toEqual(['balance', 'found', 'history', 'name', 'photo', 'status', 'uid']);
  });

  it('includes the picture, in the page itself, when the card has one', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pont-'));
    const c = await setup({ dataDir });
    mkdirSync(join(dataDir, 'photos'), { recursive: true });
    writeFileSync(join(dataDir, 'photos', c.card.id), PNG);
    c.db.prepare('update cards set photo_path=? where id=?').run(join('photos', c.card.id), c.card.id);
    const photo = (await ask(c, ['04A23B1C'])).json().cards[0].photo as string;
    expect(photo.startsWith('data:image/png;base64,')).toBe(true);
    expect(Buffer.from(photo.split(',')[1], 'base64').equals(PNG)).toBe(true);
  });

  it('leaves out a picture that is too big', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pont-'));
    const c = await setup({ dataDir });
    mkdirSync(join(dataDir, 'photos'), { recursive: true });
    writeFileSync(join(dataDir, 'photos', c.card.id), Buffer.concat([PNG, Buffer.alloc(700 * 1024)]));
    c.db.prepare('update cards set photo_path=? where id=?').run(join('photos', c.card.id), c.card.id);
    expect((await ask(c, ['04A23B1C'])).json().cards[0].photo).toBeNull();
  });

  it('tells a blocked holder so, without the history', async () => {
    const c = await setup();
    seedHistory(c);
    await c.app.inject({ method: 'PATCH', url: `/cards/${c.card.id}`, headers: auth(c.adminToken), payload: { status: 'blocked' } });
    expect((await ask(c, ['04A23B1C'])).json().cards[0]).toMatchObject({ found: true, status: 'blocked', balance: 20, history: [] });
  });

  it('says found: false for a number that is no card, whatever its spelling, and answers several at once', async () => {
    const c = await setup();
    const res = (await ask(c, ['04A23B1C', '04:00:00:01', 'junk', '04A23B1C', '0102'])).json().cards;
    expect(res.map((x: { found: boolean }) => x.found)).toEqual([true, false, false, false]);   // the repeat is dropped, the short one is not a card
    expect(res[1]).toEqual({ uid: '04:00:00:01', found: false });
    expect(res[2]).toEqual({ uid: 'junk', found: false });
  });

  it('refuses a malformed request', async () => {
    const c = await setup();
    for (const uids of [undefined, null, 'x', [], {}, [1], ['a', 2], Array.from({ length: 11 }, (_, i) => `0A0B0C0${i % 10}`), ['x'.repeat(41)]]) {
      expect((await ask(c, uids)).statusCode).toBe(400);
    }
    expect((await c.app.inject({ method: 'POST', url: '/public/cards' })).statusCode).toBe(400);
  });

  it('makes guessing card numbers pointless: a limited number of misses per address, others unaffected', async () => {
    const c = await setup();
    for (let i = 0; i < 30; i++) expect((await ask(c, [`0A00${i.toString(16).padStart(4, '0')}`], '10.9.9.9')).statusCode).toBe(200);
    const blocked = await ask(c, ['04A23B1C'], '10.9.9.9');          // even a real card, from that address
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many attempts/);
    expect((await ask(c, ['04A23B1C'], '10.8.8.8')).json().cards[0].found).toBe(true);
  });

  it('limits requests per address even when every card is real', async () => {
    const c = await setup();
    let last = 200;
    for (let i = 0; i < 125 && last === 200; i++) last = (await ask(c, ['04A23B1C'], '10.7.7.7')).statusCode;
    expect(last).toBe(429);
  });

  it('is not affected by the admin pages being live (no change is announced)', async () => {
    const c = await setup();
    let told = 0;
    const hub = c.app.live; const real = hub.notify.bind(hub); hub.notify = (...a: Parameters<typeof real>) => { told++; return real(...a); };
    await ask(c, ['04A23B1C']);
    expect(told).toBe(0);
  });
});
