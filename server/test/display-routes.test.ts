import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { makeApp, makeReader, makeOperator, makeTerminal, auth } from './helpers.js';
import type { DisplayEvent } from '../src/display.js';

const UID = '04:A2:3B:1C';

async function setup() {
  const ctx = await makeApp();
  const reader = await makeReader(ctx.app, ctx.adminToken, { name: 'Gift reader' });
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: UID, points: 46 } })).json();
  const terminals = async () => (await ctx.app.inject({ method: 'GET', url: '/terminals', headers: auth(ctx.adminToken) })).json() as any[];
  const info = async (id = reader.terminalId) => (await terminals()).find(t => t.id === id);
  const codeOf = async (id = reader.terminalId) => (await info(id)).displayCode as string;
  const events: DisplayEvent[] = [];
  ctx.app.displayHub.subscribe(reader.terminalId, e => events.push(e));
  let n = 0;
  const tap = (uid = UID, token = reader.terminalToken, path = '/fixed/tap') =>
    ctx.app.inject({ method: 'POST', url: path, headers: auth(token), payload: { cardUid: uid, idempotencyKey: `k${++n}` } });
  const enter = (code: string, ip = '192.168.0.50') => ctx.app.inject({ method: 'POST', url: '/display/enter', remoteAddress: ip, payload: { code } });
  /** Signs a screen in with the reader's code and returns the cookie header it would send afterwards. */
  const signIn = async (id = reader.terminalId) => {
    const res = await enter(await codeOf(id));
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
    return { res, cookie: raw.split(';')[0] };
  };
  return { ...ctx, reader, anna, terminals, info, codeOf, events, tap, enter, signIn };
}

describe('the code', () => {
  it('every terminal, reader or phone, gets its own 6-digit code that stays the same', async () => {
    const { app, db, reader, info, codeOf } = await setup();
    const phone = makeTerminal(app, db, 'Phone');
    const a = await codeOf();
    expect(a).toMatch(/^[1-9]\d{5}$/);
    expect(await codeOf()).toBe(a);
    const p = await codeOf(phone.terminalId);
    expect(p).toMatch(/^[1-9]\d{5}$/);
    expect(p).not.toBe(a);
    expect((await info(reader.terminalId)).displayBeep).toBe(false);
  });

  it('no two terminals share a code', async () => {
    const { app, db, terminals } = await setup();
    for (let i = 0; i < 30; i++) makeTerminal(app, db, `Phone ${i}`);
    const codes = (await terminals()).map(t => t.displayCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('the page is open to everyone, says nothing about any reader, is not cached or indexed', async () => {
    const { app } = await setup();
    const page = await app.inject({ method: 'GET', url: '/display' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.body).toContain('Enter the code');
    expect(page.body).not.toContain('Gift reader');
  });

  it('the old key-in-the-address pages are gone', async () => {
    const { app } = await setup();
    for (const url of ['/display/abcdefghijklmnopqrstuv', '/display/abcdefghijklmnopqrstuv/state', '/display/abcdefghijklmnopqrstuv/events']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });

  it('serves the page’s script and styles', async () => {
    const { app } = await setup();
    const js = await app.inject({ method: 'GET', url: '/display-assets/display.js' });
    const css = await app.inject({ method: 'GET', url: '/display-assets/display.css' });
    expect(js.statusCode).toBe(200); expect(js.headers['content-type']).toMatch(/javascript/);
    expect(css.statusCode).toBe(200); expect(css.headers['content-type']).toContain('text/css');
  });
});

describe('entering the code', () => {
  it('the right code signs the screen in: a private cookie, never in the address, and the reader’s name', async () => {
    const { signIn } = await setup();
    const { res, cookie } = await signIn();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Gift reader', mode: 'fixed', last: null });
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as string[])[0];
    expect(raw).toMatch(/^pont-display=[A-Za-z0-9_-]{30,};/);
    expect(raw).toContain('HttpOnly'); expect(raw).toContain('SameSite=Strict'); expect(raw).toContain('Path=/display'); expect(raw).toMatch(/Max-Age=\d+/);
    expect(raw).not.toContain('Secure');                       // plain http on a local network
    expect(cookie.length).toBeGreaterThan(30);
    expect(JSON.stringify(res.json())).not.toContain(cookie.split('=')[1]);   // the body never carries the session
  });

  it('is kept hashed on the server', async () => {
    const { db, signIn } = await setup();
    const { cookie } = await signIn();
    const token = cookie.split('=')[1];
    const row = db.prepare('select token_hash from display_sessions').get() as { token_hash: string };
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(db.prepare('select * from display_sessions').all())).not.toContain(token);
  });

  it('a wrong code, or something that is not 6 digits, is refused and signs nothing in', async () => {
    const { enter, codeOf, db } = await setup();
    const real = await codeOf();
    const wrong = real === '123456' ? '654321' : '123456';
    const r = await enter(wrong);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('That code is not right');
    expect(r.headers['set-cookie']).toBeUndefined();
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 456']) expect((await enter(bad)).statusCode).toBe(400);
    expect((await app_count(db))).toBe(0);
  });

  it('too many wrong codes lock that address out for a while, even for the right code', async () => {
    const { enter, codeOf } = await setup();
    const real = await codeOf();
    const wrong = real === '111111' ? '222222' : '111111';
    for (let i = 0; i < 10; i++) expect((await enter(wrong, '192.168.0.77')).statusCode).toBe(401);
    expect((await enter(wrong, '192.168.0.77')).statusCode).toBe(429);
    expect((await enter(real, '192.168.0.77')).statusCode).toBe(429);
    expect((await enter(real, '192.168.0.78')).statusCode).toBe(200);        // another address is not affected
  });

  it('wrong codes from many addresses together also stop new sign-ins for a while, but screens already signed in keep working', async () => {
    const { enter, codeOf, signIn, app } = await setup();
    const { cookie } = await signIn();
    const real = await codeOf();
    const wrong = real === '111111' ? '222222' : '111111';
    for (let i = 0; i < 300; i++) await enter(wrong, `10.0.${Math.floor(i / 200)}.${i % 200 + 1}`);
    expect((await enter(real, '10.9.9.9')).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).statusCode).toBe(200);
  });

  it('a revoked terminal’s code is no longer accepted', async () => {
    const { app, adminToken, reader, enter, codeOf } = await setup();
    const code = await codeOf();
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect((await enter(code)).statusCode).toBe(401);
  });

  it('at most 20 screens stay signed in per reader: the oldest is dropped', async () => {
    const { app, signIn, codeOf, enter } = await setup();
    const cookies: string[] = [];
    const code = await codeOf();
    for (let i = 0; i < 21; i++) {
      const r = await enter(code, `192.168.1.${i + 1}`);
      cookies.push(([] as string[]).concat(r.headers['set-cookie'] as string[])[0].split(';')[0]);
    }
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie: cookies[0] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie: cookies[20] } })).statusCode).toBe(200);
    void signIn;
  });
});

const app_count = async (db: any) => (db.prepare('select count(*) c from display_sessions').get() as { c: number }).c;

describe('a signed-in screen', () => {
  it('needs the cookie for everything: no cookie, a made-up one, or someone else’s all get 401', async () => {
    const { app } = await setup();
    for (const url of ['/display/state', '/display/events', '/display/photo/some-card']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { cookie: 'pont-display=not-a-real-session-token-at-all-123456' } })).statusCode).toBe(401);
    }
  });

  it('sees its own reader’s state and last tap', async () => {
    const { app, signIn, tap } = await setup();
    const { cookie } = await signIn();
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).json()).toMatchObject({ name: 'Gift reader', last: null });
    await tap();
    const after = (await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).json();
    expect(after.last).toMatchObject({ headline: '+10 points', balance: 56, card: { name: 'Anna Kovács' } });
  });

  it('only sees its own reader: a screen signed in to one never gets another reader’s taps', async () => {
    const { app, adminToken, signIn } = await setup();
    const other = await makeReader(app, adminToken, { name: 'Other' });
    const mine = await signIn();
    await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(other.terminalToken), payload: { cardUid: UID, idempotencyKey: 'x' } });
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie: mine.cookie } })).json().last).toBeNull();
  });

  it('can sign itself out, which makes its cookie worthless', async () => {
    const { app, signIn } = await setup();
    const { cookie } = await signIn();
    const out = await app.inject({ method: 'POST', url: '/display/leave', headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(([] as string[]).concat(out.headers['set-cookie'] as string[])[0]).toMatch(/Max-Age=0/);
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).statusCode).toBe(401);
  });

  it('is signed out the moment its terminal is revoked', async () => {
    const { app, adminToken, reader, signIn } = await setup();
    const { cookie } = await signIn();
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).statusCode).toBe(401);
  });
});

describe('new code and the beep setting', () => {
  it('a new code replaces the old one, and signs out every screen that used it', async () => {
    const { app, adminToken, reader, codeOf, enter, signIn } = await setup();
    const old = await codeOf();
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-code`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayCode).toMatch(/^[1-9]\d{5}$/);
    expect(res.json().displayCode).not.toBe(old);
    expect(await codeOf()).toBe(res.json().displayCode);
    expect((await enter(old)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).statusCode).toBe(401);
    expect((await enter(res.json().displayCode)).statusCode).toBe(200);
  });

  it('only admins can make a new code', async () => {
    const { app, db, reader } = await setup();
    const op = await makeOperator(app, db);
    for (const token of [reader.terminalToken, op.token]) {
      expect((await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-code`, headers: auth(token) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-code` })).statusCode).toBe(401);
    const adminToken = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@pont.example', password: 'adminpass' } })).json().token;
    expect((await app.inject({ method: 'POST', url: '/terminals/nope/display-code', headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('the beep is an admin setting the screen can read; it must be true or false', async () => {
    const { app, adminToken, reader, signIn } = await setup();
    const { cookie } = await signIn();
    const state = async () => (await app.inject({ method: 'GET', url: '/display/state', headers: { cookie } })).json();
    expect((await state()).beep).toBe(false);
    const patch = (body: object) => app.inject({ method: 'PATCH', url: `/terminals/${reader.terminalId}`, headers: auth(adminToken), payload: body });
    expect((await patch({ displayBeep: true })).statusCode).toBe(200);
    expect((await state()).beep).toBe(true);
    expect((await patch({ displayBeep: 'yes' })).statusCode).toBe(400);
    expect((await patch({ displayBeep: false })).statusCode).toBe(200);
    expect((await state()).beep).toBe(false);
  });
});

describe('which taps reach the page', () => {
  it('a fixed-amount grant', async () => {
    const { tap, events } = await setup();
    await tap();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tone: 'good', headline: '+10 points', balance: 56, sound: 'success' });
  });

  it('an unregistered card shows no name; a blocked one shows the name', async () => {
    const { app, adminToken, anna, tap, events } = await setup();
    await tap('04:EE:00:77');
    expect(events[0]).toMatchObject({ tone: 'refused', headline: 'Card not registered', card: null });
    await app.inject({ method: 'PATCH', url: `/cards/${anna.id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    await tap();
    expect(events[1]).toMatchObject({ headline: 'Card is blocked', card: { id: anna.id, name: 'Anna Kovács' } });
  });

  it('refusals and limits', async () => {
    const { app, adminToken, reader, tap, events } = await setup();
    await app.inject({ method: 'PATCH', url: `/terminals/${reader.terminalId}`, headers: auth(adminToken), payload: { fixed: { amount: 10, cooldownSeconds: 60, maxUses24h: null, maxPoints24h: null, maxUsesTotal: null } } });
    await tap(); await tap();
    expect(events.map(e => e.headline)).toEqual(['+10 points', 'Too soon']);
  });

  it('check-in taps: signing in shows no balance, signing out does', async () => {
    const { app, db, adminToken, tap } = await setup();
    const door = await makeReader(app, adminToken, { name: 'Door', mode: 'presence' });
    const seen: DisplayEvent[] = [];
    app.displayHub.subscribe(door.terminalId, e => seen.push(e));
    await tap(UID, door.terminalToken, '/presence/tap');
    expect(seen[0]).toMatchObject({ headline: 'Checked in', balance: null, sound: 'in' });
    db.prepare("update presence_sessions set in_at=?").run(new Date(Date.now() - 40 * 60000).toISOString());
    await tap(UID, door.terminalToken, '/presence/tap');
    expect(seen[1]).toMatchObject({ headline: 'Checked out', balance: 70, sound: 'out' });
  });

  it('an ATM charge on a phone', async () => {
    const { app, db } = await setup();
    const op = await makeOperator(app, db, 'eszter@pont.example', 'Bar 2');
    const seen: DisplayEvent[] = [];
    app.displayHub.subscribe(op.terminalId, e => seen.push(e));
    await app.inject({ method: 'POST', url: '/charges', headers: auth(op.token), payload: { cardUid: UID, amount: 8, idempotencyKey: 'a' } });
    expect(seen[0]).toMatchObject({ headline: '+8 points', balance: 54 });
  });

  it('a tap on one terminal never reaches another terminal’s page', async () => {
    const { app, adminToken, tap } = await setup();
    const other = await makeReader(app, adminToken, { name: 'Other' });
    const seen: DisplayEvent[] = [];
    app.displayHub.subscribe(other.terminalId, e => seen.push(e));
    await tap();
    expect(seen).toEqual([]);
  });

  it('a wrong-mode tap shows nothing', async () => {
    const { tap, events } = await setup();
    await tap(UID, undefined, '/presence/tap');
    expect(events).toEqual([]);
  });
});

describe('photos on a display page', () => {
  it('only for cards that tapped on that reader in the last hour, and only for a signed-in screen', async () => {
    const { app, adminToken, anna, tap, signIn } = await setup();
    const { cookie } = await signIn();
    const bence = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Bence', uid: '04:7F:91:E2' } })).json();
    expect((await app.inject({ method: 'GET', url: `/display/photo/${anna.id}`, headers: { cookie } })).statusCode).toBe(404);   // before the tap
    await tap();
    const photo = await app.inject({ method: 'GET', url: `/display/photo/${anna.id}`, headers: { cookie } });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toContain('image/svg+xml');
    expect(photo.headers['cache-control']).toContain('no-store');
    expect((await app.inject({ method: 'GET', url: `/display/photo/${bence.id}`, headers: { cookie } })).statusCode).toBe(404);   // never tapped here
    expect((await app.inject({ method: 'GET', url: `/display/photo/${anna.id}` })).statusCode).toBe(401);                          // no cookie
  });

  it('a card tapped on another reader can not be fetched through this screen', async () => {
    const { app, adminToken, anna, signIn } = await setup();
    const { cookie } = await signIn();
    const other = await makeReader(app, adminToken, { name: 'Other' });
    await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(other.terminalToken), payload: { cardUid: UID, idempotencyKey: 'x' } });
    expect((await app.inject({ method: 'GET', url: `/display/photo/${anna.id}`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('a photo file that has gone missing shows the placeholder, not an error', async () => {
    const { app, db, anna, tap, signIn } = await setup();
    const { cookie } = await signIn();
    await tap();
    db.prepare("update cards set photo_path='photos/missing-file' where id=?").run(anna.id);
    const res = await app.inject({ method: 'GET', url: `/display/photo/${anna.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });
});

describe('the live stream', () => {
  async function connect(app: any, cookie: string) {
    const base = app.server.listening ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}` : await app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${base}/display/events`, { signal: ctrl.signal, headers: cookie ? { cookie } : {} });
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = async (needle: string, ms = 3000) => {
      const end = Date.now() + ms;
      while (reader && !text.includes(needle) && Date.now() < end) {
        const r = await Promise.race([reader.read(), new Promise<{ done: false; value: undefined }>(r2 => setTimeout(() => r2({ done: false, value: undefined }), 150))]);
        if (r.done) return text.includes(needle);
        if (r.value) text += dec.decode(r.value);
      }
      return text.includes(needle);
    };
    const ended = async (ms: number) => {
      const end = Date.now() + ms;
      while (reader && Date.now() < end) {
        const r = await Promise.race([reader.read(), new Promise<{ done: false; value: undefined }>(r2 => setTimeout(() => r2({ done: false, value: undefined }), 150))]);
        if (r.done) return true;
        if (r.value) text += dec.decode(r.value);
      }
      return false;
    };
    return { res, until, ended, text: () => text, close: () => ctrl.abort() };
  }

  it('sends the state at once, then every tap as it happens', async () => {
    const { app, tap, signIn } = await setup();
    const { cookie } = await signIn();
    const s = await connect(app, cookie);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-store');
    expect(await s.until('event: hello')).toBe(true);
    expect(s.text()).toContain('"name":"Gift reader"');
    await tap();
    expect(await s.until('event: tap')).toBe(true);
    expect(s.text()).toContain('+10 points'); expect(s.text()).toContain('Anna Kovács');
    s.close(); await app.close();
  });

  it('is refused without a signed-in cookie, and past 20 viewers of one reader', async () => {
    const { app, reader, signIn } = await setup();
    const { cookie } = await signIn();
    expect((await connect(app, '')).res.status).toBe(401);
    for (let i = 0; i < 20; i++) app.displayHub.subscribe(reader.terminalId, () => {});
    expect((await connect(app, cookie)).res.status).toBe(429);
    await app.close();
  });

  it('a viewer that leaves stops receiving', async () => {
    const { app, reader, signIn } = await setup();
    const { cookie } = await signIn();
    const before = app.displayHub.count(reader.terminalId);
    const s = await connect(app, cookie);
    await s.until('event: hello');
    expect(app.displayHub.count(reader.terminalId)).toBe(before + 1);
    s.close();
    await new Promise(r => setTimeout(r, 300));
    expect(app.displayHub.count(reader.terminalId)).toBe(before);
    await app.close();
  });

  it('a new code ends the streams that were open', async () => {
    const { app, adminToken, reader, signIn } = await setup();
    const { cookie } = await signIn();
    const alone = app.displayHub.count(reader.terminalId);
    const s = await connect(app, cookie);
    await s.until('event: hello');
    await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-code`, headers: auth(adminToken) });
    expect(await s.ended(2000)).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(app.displayHub.count(reader.terminalId)).toBe(alone);
    s.close(); await app.close();
  });

  it('revoking the reader ends its streams, whichever way it is revoked', async () => {
    const { app, adminToken, reader, signIn } = await setup();
    const a = await connect(app, (await signIn()).cookie);
    await a.until('event: hello');
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect(await a.ended(2000)).toBe(true);
    a.close();
    const other = await makeReader(app, adminToken, { name: 'Second' });
    const b = await connect(app, (await signIn(other.terminalId)).cookie);
    await b.until('event: hello');
    await app.inject({ method: 'DELETE', url: `/terminals/${other.terminalId}`, headers: auth(adminToken) });
    expect(await b.ended(2000)).toBe(true);
    b.close(); await app.close();
  });

  it('shutting the server down is not held up by screens that are still open', async () => {
    const { app, signIn } = await setup();
    const s = await connect(app, (await signIn()).cookie);
    await s.until('event: hello');
    const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 3000))]);
    expect(closed).toBe(true);
    s.close();
  });
});

describe('a tap that is sent twice is shown once', () => {
  it('a repeated fixed-amount key does not replay the screen or the beep', async () => {
    const { app, reader, events } = await setup();
    const send = () => app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(reader.terminalToken), payload: { cardUid: UID, idempotencyKey: 'same' } });
    await send(); await send();
    expect(events).toHaveLength(1);
  });

  it('a repeated charge key on a phone, and a repeated check-in key, likewise', async () => {
    const { app, db, adminToken } = await setup();
    const op = await makeOperator(app, db, 'eszter@pont.example', 'Bar 2');
    const seen: DisplayEvent[] = [];
    app.displayHub.subscribe(op.terminalId, e => seen.push(e));
    const charge = () => app.inject({ method: 'POST', url: '/charges', headers: auth(op.token), payload: { cardUid: UID, amount: 8, idempotencyKey: 'a' } });
    await charge(); await charge();
    expect(seen).toHaveLength(1);
    const door = await makeReader(app, adminToken, { name: 'Door', mode: 'presence' });
    const got: DisplayEvent[] = [];
    app.displayHub.subscribe(door.terminalId, e => got.push(e));
    const checkIn = () => app.inject({ method: 'POST', url: '/presence/tap', headers: auth(door.terminalToken), payload: { cardUid: UID, idempotencyKey: 'in1' } });
    await checkIn(); await checkIn();
    expect(got).toHaveLength(1);
  });

  it('a new tap with a new key is of course shown', async () => {
    const { app, reader, events } = await setup();
    const send = (k: string) => app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(reader.terminalToken), payload: { cardUid: UID, idempotencyKey: k } });
    await send('one'); await send('two');
    expect(events).toHaveLength(2);
  });
});
