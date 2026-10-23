import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, makeTerminal, auth, makeOperator } from './helpers.js';
import { openDb } from '../src/db.js';
import { DEFAULT_SETTINGS, defaultZone } from '../src/presence.js';

const UID = '04:A2:3B:1C';

async function setup() {
  const ctx = await makeApp();
  const door = makeTerminal(ctx.app, ctx.db, 'Door');
  const back = makeTerminal(ctx.app, ctx.db, 'Back');
  const bar = makeTerminal(ctx.app, ctx.db, 'Bar');
  ctx.db.prepare("update terminals set mode='presence' where id in (?,?)").run(door.terminalId, back.terminalId);
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: UID, points: 46 } })).json();
  let n = 0;
  const tap = (t: { terminalToken: string }, uid = UID, key = `k${++n}`) =>
    ctx.app.inject({ method: 'POST', url: '/presence/tap', headers: auth(t.terminalToken), payload: { cardUid: uid, idempotencyKey: key } });
  /** Pretend the open visit began [minutes] ago. */
  const backdate = (minutes: number) => ctx.db.prepare("update presence_sessions set in_at=? where status='open'").run(new Date(Date.now() - minutes * 60000).toISOString());
  const zoneId = defaultZone(ctx.db).id;
  /** Changes the rules of the default zone. */
  const put = (settings: object) => ctx.app.inject({ method: 'PUT', url: `/zones/${zoneId}`, headers: auth(ctx.adminToken), payload: { settings: { ...DEFAULT_SETTINGS, ...settings } } });
  const makeZone = async (name: string, settings: object = {}) =>
    (await ctx.app.inject({ method: 'POST', url: '/zones', headers: auth(ctx.adminToken), payload: { name, settings: { ...DEFAULT_SETTINGS, ...settings } } })).json();
  /** Sets mode, zone and point type of a terminal the way the admin site does. */
  const setup_ = (t: { terminalId: string }, body: { mode?: string; zoneId?: string; direction?: string }) =>
    ctx.app.inject({ method: 'PATCH', url: `/terminals/${t.terminalId}`, headers: auth(ctx.adminToken), payload: body });
  const balance = () => (ctx.db.prepare('select balance from cards where id=?').get(anna.id) as { balance: number }).balance;
  const count = (sql: string) => (ctx.db.prepare(sql).get() as { c: number }).c;
  return { ...ctx, door, back, bar, anna, tap, backdate, put, balance, count, zoneId, makeZone, assign: setup_ };
}

describe('checking in and out', () => {
  it('the first tap checks in', async () => {
    const { door, tap, count } = await setup();
    const res = await tap(door);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'in', points: 0, card: { name: 'Anna Kovács', balance: 46 }, today: { earned: 0, max: null } });
    expect(res.json().inAt).toBeTruthy();
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(1);
  });

  it('a tap after the lock-out checks out and credits 8 points per 12 minutes, rounded down', async () => {
    const { door, tap, backdate, balance, db, anna } = await setup();
    await tap(door); backdate(40);
    const res = await tap(door);
    expect(res.json()).toMatchObject({ action: 'out', minutes: 40, points: 24, raw: 24, cappedBy: null, card: { balance: 70 }, today: { earned: 24 } });
    expect(balance()).toBe(70);
    const t = db.prepare("select * from transactions where kind='presence'").get() as any;
    expect(t).toMatchObject({ card_id: anna.id, amount: 24, type: 'give', status: 'ok', note: '40 min', operator_id: null, balance_after: 70 });
    const s = db.prepare('select * from presence_sessions').get() as any;
    expect(s).toMatchObject({ status: 'closed', minutes: 40, points: 24, tx_id: t.id });
  });

  it('a tap inside the lock-out changes nothing and says so', async () => {
    const { door, tap, count } = await setup();
    await tap(door);
    const res = await tap(door);
    expect(res.json()).toMatchObject({ action: 'cooldown' });
    expect(count("select count(*) c from presence_sessions")).toBe(1);
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(1);
  });

  it('a zero lock-out lets a tap check out straight away', async () => {
    const { door, tap, put, backdate } = await setup();
    await put({ cooldownSeconds: 0 }); await tap(door); backdate(0);
    expect((await tap(door)).json()).toMatchObject({ action: 'out', minutes: 0, points: 0 });
  });

  it('after checking out, the next tap starts a new visit', async () => {
    const { door, tap, backdate, count } = await setup();
    await tap(door); backdate(30); await tap(door);
    expect((await tap(door)).json().action).toBe('in');
    expect(count("select count(*) c from presence_sessions")).toBe(2);
  });

  it('a card is inside system-wide: it can check in at one terminal and out at another', async () => {
    const { door, back, tap, backdate, db } = await setup();
    await tap(door); backdate(24);
    const res = await tap(back);
    expect(res.json()).toMatchObject({ action: 'out', points: 16 });
    const s = db.prepare('select in_terminal, out_terminal from presence_sessions').get() as any;
    expect(s.in_terminal).toBe(door.terminalId); expect(s.out_terminal).toBe(back.terminalId);
  });

  it('two cards are independent', async () => {
    const { app, adminToken, door, tap, count } = await setup();
    await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Bence', uid: '04:7F:91:E2' } });
    await tap(door); await tap(door, '04:7F:91:E2');
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(2);
  });
});

describe('a repeated tap key', () => {
  it('replaying a check-in returns the check-in, not a lock-out, and opens nothing new', async () => {
    const { door, tap, count } = await setup();
    await tap(door, UID, 'same');
    const again = await tap(door, UID, 'same');
    expect(again.json().action).toBe('in');
    expect(count("select count(*) c from presence_sessions")).toBe(1);
  });

  it('replaying a check-out returns the same result and awards once', async () => {
    const { door, tap, backdate, balance, count } = await setup();
    await tap(door); backdate(36);
    const first = await tap(door, UID, 'out-key');
    const again = await tap(door, UID, 'out-key');
    expect(again.json()).toMatchObject({ action: 'out', points: 24, minutes: 36, card: { balance: 70 } });
    expect(first.json().outAt).toBe(again.json().outAt);
    expect(balance()).toBe(70);
    expect(count("select count(*) c from transactions where kind='presence'")).toBe(1);
  });

  it('keys are per terminal', async () => {
    const { door, back, tap, count } = await setup();
    await tap(door, UID, 'x');
    await tap(back, UID, 'x'); // different terminal, same key text: a real tap, inside the lock-out
    expect(count("select count(*) c from presence_sessions")).toBe(1);
  });

  it('a missing key is a 400', async () => {
    const { app, door } = await setup();
    const res = await app.inject({ method: 'POST', url: '/presence/tap', headers: auth(door.terminalToken), payload: { cardUid: UID } });
    expect(res.statusCode).toBe(400);
  });
});

describe('a forgotten sign-out', () => {
  it('earns nothing, closes the old visit as expired and starts a new check-in', async () => {
    const { door, tap, backdate, balance, db } = await setup();
    await tap(door); backdate(13 * 60);
    const res = await tap(door);
    expect(res.json()).toMatchObject({ action: 'expired_in', points: 0, expiredMinutes: 780 });
    expect(balance()).toBe(46);
    const rows = db.prepare('select status, points from presence_sessions order by id').all();
    expect(rows).toEqual([{ status: 'expired', points: 0 }, { status: 'open', points: 0 }]);
  });

  it('replaying that tap still says expired_in', async () => {
    const { door, tap, backdate } = await setup();
    await tap(door); backdate(13 * 60);
    await tap(door, UID, 'late');
    expect((await tap(door, UID, 'late')).json()).toMatchObject({ action: 'expired_in', expiredMinutes: 780 });
  });

  it('the longest stay is a setting', async () => {
    const { door, tap, backdate, put } = await setup();
    await put({ maxStayHours: 2 }); await tap(door); backdate(130);
    expect((await tap(door)).json().action).toBe('expired_in');
  });
});

describe('rules in effect', () => {
  it('below the minimum minutes closes the visit with no points and no transaction', async () => {
    const { door, tap, backdate, put, count } = await setup();
    await put({ minMinutes: 10 }); await tap(door); backdate(5);
    expect((await tap(door)).json()).toMatchObject({ action: 'out', minutes: 5, points: 0 });
    expect(count("select count(*) c from transactions")).toBe(0);
  });

  it('rounding and rates come from the saved settings', async () => {
    const { door, tap, backdate, put } = await setup();
    await put({ pointsPerBlock: 5, blockMinutes: 10, rounding: 'up' }); await tap(door); backdate(21);
    expect((await tap(door)).json()).toMatchObject({ points: 15 });
  });

  it('the per-visit cap applies and is reported', async () => {
    const { door, tap, backdate, put } = await setup();
    await put({ maxPointsVisit: 10 }); await tap(door); backdate(60);
    expect((await tap(door)).json()).toMatchObject({ points: 10, raw: 40, cappedBy: 'visit' });
  });

  it('the rolling 24 h allowance is shared across visits, and a storno gives the points back', async () => {
    const { app, adminToken, door, tap, backdate, put, db } = await setup();
    await put({ maxPoints24h: 30 });
    await tap(door); backdate(36); const v1 = (await tap(door)).json();
    expect(v1).toMatchObject({ points: 24, today: { earned: 24, max: 30 } });
    await tap(door); backdate(60); const v2 = (await tap(door)).json();
    expect(v2).toMatchObject({ points: 6, cappedBy: '24h', today: { earned: 30, max: 30 } });
    await tap(door); backdate(60); expect((await tap(door)).json()).toMatchObject({ points: 0, cappedBy: '24h' });
    const first = db.prepare("select id from transactions where kind='presence' order by id limit 1").get() as { id: number };
    expect((await app.inject({ method: 'POST', url: `/transactions/${first.id}/storno`, headers: auth(adminToken) })).statusCode).toBe(200);
    await tap(door); backdate(36);
    expect((await tap(door)).json()).toMatchObject({ points: 24 });
  });

  it('awards older than 24 hours no longer count against the allowance', async () => {
    const { door, tap, backdate, put, db } = await setup();
    await put({ maxPoints24h: 30 });
    await tap(door); backdate(36); await tap(door);
    db.prepare("update transactions set created_at=? where kind='presence'").run(new Date(Date.now() - 25 * 3600 * 1000).toISOString());
    await tap(door); backdate(36);
    expect((await tap(door)).json()).toMatchObject({ points: 24, cappedBy: null });
  });
});

describe('refusals', () => {
  it('an ATM-mode terminal refuses check-in taps', async () => {
    const { bar, tap, count } = await setup();
    const res = await tap(bar);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wrong_mode');
    expect(count("select count(*) c from presence_sessions")).toBe(0);
  });

  it('a blocked card is refused and nothing changes', async () => {
    const { app, adminToken, anna, door, tap, count } = await setup();
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    const res = await tap(door);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'card_blocked', card: { name: 'Anna Kovács' } });
    expect(count("select count(*) c from presence_sessions")).toBe(0);
  });

  it('a card that is inside when blocked cannot check out until unblocked', async () => {
    const { app, adminToken, anna, door, tap, backdate, balance } = await setup();
    await tap(door); backdate(36);
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    expect((await tap(door)).statusCode).toBe(403);
    expect(balance()).toBe(46);
  });

  it('an unregistered card is refused and recorded as a suggestion automatically', async () => {
    const { app, adminToken, door, tap, count } = await setup();
    const res = await tap(door, '04:EE:00:77');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('unknown_card');
    expect(count("select count(*) c from presence_sessions")).toBe(0);
    const list = (await app.inject({ method: 'GET', url: '/card-suggestions', headers: auth(adminToken) })).json();
    expect(list.map((r: { uid: string }) => r.uid)).toEqual(['04:EE:00:77']);
  });

  it('a revoked phone is refused', async () => {
    const { app, adminToken, door, tap } = await setup();
    await app.inject({ method: 'DELETE', url: `/terminals/${door.terminalId}`, headers: auth(adminToken) });
    expect((await tap(door)).statusCode).toBe(401);
  });

  it('admins cannot tap', async () => {
    const { app, adminToken } = await setup();
    const res = await app.inject({ method: 'POST', url: '/presence/tap', headers: auth(adminToken), payload: { cardUid: UID, idempotencyKey: 'a' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('admin: settings, preview, who is inside', () => {
  it('the default zone starts with the default rules; rules save, and nonsense is refused with a message', async () => {
    const { app, adminToken, put, zoneId } = await setup();
    const rules = async () => ((await app.inject({ method: 'GET', url: '/zones', headers: auth(adminToken) })).json() as { id: string; settings: object }[]).find(z => z.id === zoneId)!.settings;
    expect(await rules()).toEqual(DEFAULT_SETTINGS);
    expect((await put({ pointsPerBlock: 10, maxPoints24h: 100 })).statusCode).toBe(200);
    expect(await rules()).toMatchObject({ pointsPerBlock: 10, maxPoints24h: 100 });
    const bad = await put({ blockMinutes: 0 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('blockMinutes');
    expect((await rules() as { blockMinutes: number }).blockMinutes).toBe(12);
  });

  it('only admins touch zones', async () => {
    const { app, db, door, zoneId } = await setup();
    const op = await makeOperator(app, db);
    for (const token of [door.terminalToken, op.token]) {
      expect((await app.inject({ method: 'GET', url: '/zones', headers: auth(token) })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/zones', headers: auth(token), payload: { name: 'x' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PUT', url: `/zones/${zoneId}`, headers: auth(token), payload: { name: 'x' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/zones/${zoneId}`, headers: auth(token) })).statusCode).toBe(403);
    }
  });

  it('preview uses the saved settings, or a draft without saving it', async () => {
    const { app, adminToken, put, makeZone } = await setup();
    const preview = (payload: object) => app.inject({ method: 'POST', url: '/presence/preview', headers: auth(adminToken), payload });
    expect((await preview({ minutes: [5, 12, 50] })).json()).toEqual([
      { minutes: 5, raw: 0, awarded: 0, cappedBy: null }, { minutes: 12, raw: 8, awarded: 8, cappedBy: null }, { minutes: 50, raw: 32, awarded: 32, cappedBy: null }]);
    const draft = (await preview({ minutes: [50], settings: { ...DEFAULT_SETTINGS, rounding: 'up', maxPointsVisit: 30 } })).json();
    expect(draft).toEqual([{ minutes: 50, raw: 40, awarded: 30, cappedBy: 'visit' }]);
    await put({ pointsPerBlock: 1 });
    expect((await preview({ minutes: [12] })).json()[0].awarded).toBe(1);
    const gym = await makeZone('Gym', { pointsPerBlock: 3 });
    expect((await preview({ minutes: [12], zoneId: gym.id })).json()[0].awarded).toBe(3);
    expect((await preview({ minutes: [12], zoneId: 'nope' })).statusCode).toBe(404);
    expect((await preview({ minutes: [12], settings: { ...DEFAULT_SETTINGS, blockMinutes: 0 } })).statusCode).toBe(400);
    expect((await preview({ minutes: 'x' })).statusCode).toBe(400);
  });

  it('lists who is inside with minutes so far and what they would earn, and recent visits', async () => {
    const { app, adminToken, door, tap, backdate } = await setup();
    await tap(door); backdate(25);
    let res = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json();
    expect(res.inside).toHaveLength(1);
    expect(res.inside[0]).toMatchObject({ minutes: 25, wouldEarn: 16, terminal: 'Door', card: { name: 'Anna Kovács' } });
    expect(res.recent).toHaveLength(0);
    await tap(door);
    res = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json();
    expect(res.inside).toHaveLength(0);
    expect(res.recent[0]).toMatchObject({ status: 'closed', minutes: 25, points: 16 });
  });

  it('signing out a forgotten (overdue) visit from admin earns nothing and marks it forgotten', async () => {
    const { app, adminToken, door, tap, backdate, balance, count } = await setup();
    await tap(door); backdate(3 * 24 * 60);
    const inside = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json().inside[0];
    expect(inside.overdue).toBe(true);
    const res = await app.inject({ method: 'POST', url: `/presence/sessions/${inside.id}/close`, headers: auth(adminToken), payload: { award: true } });
    expect(res.json()).toMatchObject({ ok: true, points: 0 });
    expect(balance()).toBe(46);
    expect(count("select count(*) c from transactions where kind='presence'")).toBe(0);
    expect(count("select count(*) c from presence_sessions where status='expired'")).toBe(1);
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(0);
  });

  it('a visit just inside the longest stay is still paid when an admin signs it out', async () => {
    const { app, adminToken, door, tap, backdate, balance } = await setup();
    await tap(door); backdate(11 * 60);
    const id = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json().inside[0].id;
    expect((await app.inject({ method: 'POST', url: `/presence/sessions/${id}/close`, headers: auth(adminToken), payload: { award: true } })).json().points).toBe(440);
    expect(balance()).toBe(486);
  });

  it('an admin can sign someone out with points, or discard the visit', async () => {
    const { app, adminToken, door, tap, backdate, balance, count } = await setup();
    await tap(door); backdate(24);
    const open = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json().inside[0].id;
    const out = await app.inject({ method: 'POST', url: `/presence/sessions/${open}/close`, headers: auth(adminToken), payload: { award: true } });
    expect(out.json()).toMatchObject({ ok: true, points: 16 });
    expect(balance()).toBe(62);
    expect((await app.inject({ method: 'POST', url: `/presence/sessions/${open}/close`, headers: auth(adminToken), payload: { award: true } })).statusCode).toBe(404);
    await tap(door); backdate(24);
    const next = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json().inside[0].id;
    const dis = await app.inject({ method: 'POST', url: `/presence/sessions/${next}/close`, headers: auth(adminToken), payload: { award: false } });
    expect(dis.json()).toMatchObject({ ok: true, points: 0 });
    expect(balance()).toBe(62);
    expect(count("select count(*) c from presence_sessions where status='discarded'")).toBe(1);
  });
});

describe('terminal mode', () => {
  it('a phone reads its mode and name; an admin changes the mode', async () => {
    const { app, adminToken, bar } = await setup();
    const config = () => app.inject({ method: 'GET', url: '/terminal/config', headers: auth(bar.terminalToken) });
    expect((await config()).json()).toEqual({ mode: 'atm', name: 'Bar', direction: 'toggle', zoneName: null, kind: 'phone' });
    const patch = await app.inject({ method: 'PATCH', url: `/terminals/${bar.terminalId}`, headers: auth(adminToken), payload: { mode: 'presence' } });
    expect(patch.statusCode).toBe(200);
    expect((await config()).json().mode).toBe('presence');
    const list = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(list.find((t: { name: string }) => t.name === 'Bar').mode).toBe('presence');
  });

  it('refuses an unknown mode and non-admins', async () => {
    const { app, adminToken, bar } = await setup();
    expect((await app.inject({ method: 'PATCH', url: `/terminals/${bar.terminalId}`, headers: auth(adminToken), payload: { mode: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/terminals/${bar.terminalId}`, headers: auth(bar.terminalToken), payload: { mode: 'presence' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/terminals/missing', headers: auth(adminToken), payload: { mode: 'atm' } })).statusCode).toBe(404);
  });

  it('check-out awards show kind and note in the admin transaction list', async () => {
    const { app, adminToken, door, tap, backdate } = await setup();
    await tap(door); backdate(36); await tap(door);
    const rows = (await app.inject({ method: 'GET', url: '/transactions', headers: auth(adminToken) })).json();
    expect(rows[0]).toMatchObject({ kind: 'presence', note: '36 min', amount: 24, terminal: 'Door' });
  });
});

describe('upgrading an existing database', () => {
  it('adds the new columns to tables made by an older version', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pont-mig-')), 'old.db');
    const old = new Database(path);
    old.exec(`create table terminals(id text primary key, name text not null, place text not null default '', active integer not null default 1, last_seen text, app_version text, device text, instant_preset integer not null default 1, last_operator text, presets_saved integer not null default 0);
      create table transactions(id integer primary key autoincrement, card_id text not null, amount integer not null, type text not null, status text not null default 'ok', ref integer, terminal_id text, operator_id text, idempotency_key text, created_at text not null, balance_after integer not null default 0);
      insert into terminals(id,name) values('t1','Old terminal');`);
    old.close();
    const db = openDb(path);
    const cols = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map(c => c.name);
    expect(cols('terminals')).toEqual(expect.arrayContaining(['mode', 'zone_id', 'direction']));
    expect(cols('transactions')).toEqual(expect.arrayContaining(['kind', 'note', 'zone_id']));
    expect((db.prepare("select mode from terminals where id='t1'").get() as { mode: string }).mode).toBe('atm');
    expect(() => openDb(path)).not.toThrow();
  });
});

describe('zones', () => {
  it('lists the default zone, creates, renames, and refuses duplicates and nonsense', async () => {
    const { app, adminToken, makeZone, zoneId } = await setup();
    const list = async () => (await app.inject({ method: 'GET', url: '/zones', headers: auth(adminToken) })).json();
    expect((await list()).map((z: { name: string }) => z.name)).toEqual(['Main area']);
    const gym = await makeZone('Gym', { pointsPerBlock: 3 });
    expect(gym).toMatchObject({ name: 'Gym', settings: { pointsPerBlock: 3 } });
    const dup = await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'gym' } });
    expect(dup.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Bad', settings: { ...DEFAULT_SETTINGS, rounding: 'x' } } })).statusCode).toBe(400);
    const ren = await app.inject({ method: 'PUT', url: `/zones/${gym.id}`, headers: auth(adminToken), payload: { name: 'Gym floor' } });
    expect(ren.json()).toMatchObject({ name: 'Gym floor', settings: { pointsPerBlock: 3 } });
    expect((await app.inject({ method: 'PUT', url: `/zones/${gym.id}`, headers: auth(adminToken), payload: { name: 'Main area' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/zones/nope', headers: auth(adminToken), payload: { name: 'x' } })).statusCode).toBe(404);
    void zoneId;
  });

  it('a new zone without rules gets the defaults', async () => {
    const { app, adminToken } = await setup();
    const res = await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Plain' } });
    expect(res.json().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('cannot be deleted while a terminal uses it or a visit happened in it; can when unused', async () => {
    const { app, adminToken, door, tap, makeZone, assign } = await setup();
    const gym = await makeZone('Gym');
    await assign(door, { zoneId: gym.id });
    const used = await app.inject({ method: 'DELETE', url: `/zones/${gym.id}`, headers: auth(adminToken) });
    expect(used.statusCode).toBe(409);
    expect(used.json().error).toMatch(/terminal/);
    await tap(door);
    await assign(door, { zoneId: (await app.inject({ method: 'GET', url: '/zones', headers: auth(adminToken) })).json()[0].id });
    const visited = await app.inject({ method: 'DELETE', url: `/zones/${gym.id}`, headers: auth(adminToken) });
    expect(visited.statusCode).toBe(409);
    expect(visited.json().error).toMatch(/visit/);
    const spare = await makeZone('Spare');
    expect((await app.inject({ method: 'DELETE', url: `/zones/${spare.id}`, headers: auth(adminToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/zones/${spare.id}`, headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('the last zone cannot be deleted', async () => {
    const { app, adminToken, zoneId } = await setup();
    const res = await app.inject({ method: 'DELETE', url: `/zones/${zoneId}`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(409);
  });

  it('terminals are assigned a zone and a point type; bad values are refused; config tells the phone', async () => {
    const { app, adminToken, bar, makeZone, assign } = await setup();
    const gym = await makeZone('Gym');
    expect((await assign(bar, { mode: 'presence', zoneId: gym.id, direction: 'in' })).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(list.find((t: { name: string }) => t.name === 'Bar')).toMatchObject({ mode: 'presence', zoneId: gym.id, zoneName: 'Gym', direction: 'in' });
    const config = (await app.inject({ method: 'GET', url: '/terminal/config', headers: auth(bar.terminalToken) })).json();
    expect(config).toEqual({ mode: 'presence', name: 'Bar', direction: 'in', zoneName: 'Gym', kind: 'phone' });
    expect((await assign(bar, { direction: 'sideways' })).statusCode).toBe(400);
    expect((await assign(bar, { zoneId: 'nope' })).statusCode).toBe(404);
  });

  it('switching a terminal to check-in without choosing a zone puts it in the default zone', async () => {
    const { app, adminToken, bar, assign, zoneId } = await setup();
    await assign(bar, { mode: 'presence' });
    const t = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json().find((x: { name: string }) => x.name === 'Bar');
    expect(t).toMatchObject({ zoneId, direction: 'toggle' });
  });
});

describe('rules are per zone', () => {
  it('a visit is paid by the rules of the zone where it began, whichever terminal signs out', async () => {
    const { door, back, tap, backdate, makeZone, assign } = await setup();
    const gym = await makeZone('Gym', { pointsPerBlock: 3 });
    await assign(door, { zoneId: gym.id });             // Door is in the Gym; Back is in the default zone (8 per 12 min)
    await tap(door); backdate(36);
    expect((await tap(back)).json()).toMatchObject({ action: 'out', points: 9, zone: { name: 'Gym' } });
  });

  it('the 24 h allowance is separate in each zone', async () => {
    const { door, back, tap, backdate, put, makeZone, assign } = await setup();
    await put({ maxPoints24h: 30 });
    const gym = await makeZone('Gym', { maxPoints24h: 30 });
    await assign(back, { zoneId: gym.id });
    await tap(door); backdate(36); expect((await tap(door)).json()).toMatchObject({ points: 24, today: { earned: 24, max: 30 } });
    await tap(back); backdate(36);
    expect((await tap(back)).json()).toMatchObject({ points: 24, cappedBy: null, today: { earned: 24, max: 30 } });
  });

  it('caps, rounding and lock-out come from the visit’s zone', async () => {
    const { door, tap, backdate, makeZone, assign } = await setup();
    const strict = await makeZone('Strict', { maxStayHours: 1, cooldownSeconds: 0, rounding: 'up' });
    await assign(door, { zoneId: strict.id });
    await tap(door); backdate(0);
    expect((await tap(door)).json()).toMatchObject({ action: 'out', minutes: 0 }); // lock-out 0 in this zone
    await tap(door); backdate(61);
    expect((await tap(door)).json().action).toBe('expired_in');                   // longest stay 1 h in this zone
  });

  it('the visit and the award remember the zone', async () => {
    const { app, adminToken, door, tap, backdate, db, makeZone, assign } = await setup();
    const gym = await makeZone('Gym');
    await assign(door, { zoneId: gym.id });
    await tap(door); backdate(36); await tap(door);
    expect((db.prepare('select zone_id from presence_sessions').get() as { zone_id: string }).zone_id).toBe(gym.id);
    expect((db.prepare("select zone_id from transactions where kind='presence'").get() as { zone_id: string }).zone_id).toBe(gym.id);
    const rows = (await app.inject({ method: 'GET', url: '/transactions', headers: auth(adminToken) })).json();
    expect(rows[0]).toMatchObject({ kind: 'presence', zone: 'Gym' });
    const sessions = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json();
    expect(sessions.recent[0].zone).toBe('Gym');
  });

  it('who is inside shows the zone and what they would earn under its rules', async () => {
    const { app, adminToken, door, tap, backdate, makeZone, assign } = await setup();
    const gym = await makeZone('Gym', { pointsPerBlock: 3 });
    await assign(door, { zoneId: gym.id });
    await tap(door); backdate(36);
    const inside = (await app.inject({ method: 'GET', url: '/presence/sessions', headers: auth(adminToken) })).json().inside[0];
    expect(inside).toMatchObject({ zone: 'Gym', wouldEarn: 9 });
  });
});

describe('point types', () => {
  async function gate() {
    const c = await setup();
    await c.assign(c.door, { direction: 'in' });
    await c.assign(c.back, { direction: 'out' });
    return c;
  }

  it('a sign-in point signs in; tapping again later says already checked in and changes nothing', async () => {
    const { door, tap, backdate, count, balance } = await gate();
    expect((await tap(door)).json().action).toBe('in');
    backdate(40);
    const again = await tap(door);
    expect(again.json()).toMatchObject({ action: 'already_in', zone: { name: 'Main area' } });
    expect(again.json().inAt).toBeTruthy();
    expect(count("select count(*) c from presence_sessions")).toBe(1);
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(1);
    expect(balance()).toBe(46);
  });

  it('a sign-in point inside the lock-out says cooldown', async () => {
    const { door, tap } = await gate();
    await tap(door);
    expect((await tap(door)).json().action).toBe('cooldown');
  });

  it('a sign-out point with nobody inside says not_in and changes nothing', async () => {
    const { back, tap, count } = await gate();
    const res = await tap(back);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'not_in', points: 0, card: { name: 'Anna Kovács' } });
    expect(res.json().inAt).toBeUndefined();
    expect(count("select count(*) c from presence_sessions")).toBe(0);
  });

  it('a sign-out point signs out and pays', async () => {
    const { door, back, tap, backdate, balance } = await gate();
    await tap(door); backdate(36);
    expect((await tap(back)).json()).toMatchObject({ action: 'out', points: 24 });
    expect(balance()).toBe(70);
  });

  it('a sign-out point inside the lock-out says cooldown and does not sign out', async () => {
    const { door, back, tap, count } = await gate();
    await tap(door);
    expect((await tap(back)).json().action).toBe('cooldown');
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(1);
  });

  it('a forgotten visit at a sign-out point earns nothing and does not start a new visit', async () => {
    const { back, door, tap, backdate, count, balance } = await gate();
    await tap(door); backdate(13 * 60);
    const res = await tap(back);
    expect(res.json()).toMatchObject({ action: 'expired_out', points: 0, expiredMinutes: 780 });
    expect(count("select count(*) c from presence_sessions where status='expired'")).toBe(1);
    expect(count("select count(*) c from presence_sessions where status='open'")).toBe(0);
    expect(balance()).toBe(46);
  });

  it('a forgotten visit at a sign-in point starts a fresh check-in', async () => {
    const { door, tap, backdate } = await gate();
    await tap(door); backdate(13 * 60);
    expect((await tap(door)).json()).toMatchObject({ action: 'expired_in', expiredMinutes: 780 });
  });

  it('replaying a sign-out point tap returns the same result', async () => {
    const { door, back, tap, backdate, balance } = await gate();
    await tap(door); backdate(36);
    await tap(back, UID, 'out1');
    expect((await tap(back, UID, 'out1')).json()).toMatchObject({ action: 'out', points: 24 });
    expect(balance()).toBe(70);
  });

  it('a toggle point does both', async () => {
    const { door, tap, backdate, assign } = await gate();
    await assign(door, { direction: 'toggle' });
    expect((await tap(door)).json().action).toBe('in');
    backdate(36);
    expect((await tap(door)).json().action).toBe('out');
  });

  it('a sign-in point in a second zone does not move someone who is still inside the first', async () => {
    const { door, back, tap, backdate, makeZone, assign } = await gate();
    const gym = await makeZone('Gym');
    await assign(back, { direction: 'in', zoneId: gym.id });
    await tap(door); backdate(40);
    expect((await tap(back)).json()).toMatchObject({ action: 'already_in', zone: { name: 'Main area' } });
  });

  it('a card tapped at a terminal with the wrong mode or a blocked card is still refused at gates', async () => {
    const { app, adminToken, anna, bar, back, tap } = await gate();
    expect((await tap(bar)).statusCode).toBe(409);
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    expect((await tap(back)).statusCode).toBe(403);
  });
});
