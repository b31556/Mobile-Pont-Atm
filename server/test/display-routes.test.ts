import { describe, it, expect } from 'vitest';
import { makeApp, makeReader, makeOperator, makeTerminal, auth } from './helpers.js';
import type { DisplayEvent } from '../src/display.js';

const UID = '04:A2:3B:1C';

async function setup() {
  const ctx = await makeApp();
  const reader = await makeReader(ctx.app, ctx.adminToken, { name: 'Gift reader' });
  const anna = (await ctx.app.inject({ method: 'POST', url: '/cards', headers: auth(ctx.adminToken), payload: { name: 'Anna Kovács', uid: UID, points: 46 } })).json();
  const terminals = async () => (await ctx.app.inject({ method: 'GET', url: '/terminals', headers: auth(ctx.adminToken) })).json() as any[];
  const info = async (id = reader.terminalId) => (await terminals()).find(t => t.id === id);
  const tokenOf = async (id = reader.terminalId) => (await info(id)).displayPath.replace('/display/', '') as string;
  const events: DisplayEvent[] = [];
  ctx.app.displayHub.subscribe(reader.terminalId, e => events.push(e));
  let n = 0;
  const tap = (uid = UID, token = reader.terminalToken, path = '/fixed/tap') =>
    ctx.app.inject({ method: 'POST', url: path, headers: auth(token), payload: { cardUid: uid, idempotencyKey: `k${++n}` } });
  return { ...ctx, reader, anna, terminals, info, tokenOf, events, tap };
}

describe('the link', () => {
  it('every terminal, reader or phone, gets a long random link that stays the same', async () => {
    const { app, db, reader, info, terminals } = await setup();
    const phone = makeTerminal(app, db, 'Phone');
    const a = (await info()).displayPath as string;
    expect(a).toMatch(/^\/display\/[A-Za-z0-9_-]{22,}$/);
    expect((await info()).displayPath).toBe(a);
    const p = (await info(phone.terminalId)).displayPath as string;
    expect(p).toMatch(/^\/display\/[A-Za-z0-9_-]{22,}$/);
    expect(p).not.toBe(a);
    expect((await terminals()).find(t => t.id === reader.terminalId).displayBeep).toBe(false);
  });

  it('opens without logging in, is not cached or indexed, and answers 404 to a wrong key', async () => {
    const { app, tokenOf } = await setup();
    const t = await tokenOf();
    const page = await app.inject({ method: 'GET', url: `/display/${t}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toContain('no-store');
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body).toContain('Tap your card');
    expect((await app.inject({ method: 'GET', url: '/display/not-a-real-key-at-all-123456' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/display/${t}/state` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/display/short' })).statusCode).toBe(404);
  });

  it('serves the page’s script and styles', async () => {
    const { app } = await setup();
    const js = await app.inject({ method: 'GET', url: '/display-assets/display.js' });
    const css = await app.inject({ method: 'GET', url: '/display-assets/display.css' });
    expect(js.statusCode).toBe(200); expect(js.headers['content-type']).toMatch(/javascript/);
    expect(css.statusCode).toBe(200); expect(css.headers['content-type']).toContain('text/css');
  });

  it('a new link cuts off the old one at once; only admins can make one', async () => {
    const { app, db, adminToken, reader, info, tokenOf } = await setup();
    const old = await tokenOf();
    const op = await makeOperator(app, db);
    for (const token of [reader.terminalToken, op.token]) {
      expect((await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-link`, headers: auth(token) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-link` })).statusCode).toBe(401);
    const res = await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-link`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayPath).toBe((await info()).displayPath);
    expect(res.json().displayPath).not.toBe(`/display/${old}`);
    expect((await app.inject({ method: 'GET', url: `/display/${old}/state` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: res.json().displayPath + '/state' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/terminals/nope/display-link', headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('a revoked terminal’s page is gone', async () => {
    const { app, adminToken, reader, tokenOf } = await setup();
    const t = await tokenOf();
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect((await app.inject({ method: 'GET', url: `/display/${t}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/display/${t}/state` })).statusCode).toBe(404);
  });

  it('the beep is an admin setting that the page can read; it must be true or false', async () => {
    const { app, adminToken, reader, tokenOf } = await setup();
    const t = await tokenOf();
    const state = async () => (await app.inject({ method: 'GET', url: `/display/${t}/state` })).json();
    expect((await state()).beep).toBe(false);
    const patch = (body: object) => app.inject({ method: 'PATCH', url: `/terminals/${reader.terminalId}`, headers: auth(adminToken), payload: body });
    expect((await patch({ displayBeep: true })).statusCode).toBe(200);
    expect((await state()).beep).toBe(true);
    expect((await patch({ displayBeep: 'yes' })).statusCode).toBe(400);
    expect((await state()).beep).toBe(true);
    expect((await patch({ displayBeep: false })).statusCode).toBe(200);
    expect((await state()).beep).toBe(false);
  });

  it('the state says which reader this is and what its last tap was', async () => {
    const { app, tap, tokenOf } = await setup();
    const t = await tokenOf();
    const before = (await app.inject({ method: 'GET', url: `/display/${t}/state` })).json();
    expect(before).toMatchObject({ name: 'Gift reader', mode: 'fixed', last: null });
    await tap();
    const after = (await app.inject({ method: 'GET', url: `/display/${t}/state` })).json();
    expect(after.last).toMatchObject({ headline: '+10 points', balance: 56, card: { name: 'Anna Kovács' } });
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
  it('only for cards that tapped on that terminal in the last hour', async () => {
    const { app, adminToken, anna, tap, tokenOf } = await setup();
    const t = await tokenOf();
    const bence = (await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Bence', uid: '04:7F:91:E2' } })).json();
    expect((await app.inject({ method: 'GET', url: `/display/${t}/photo/${anna.id}` })).statusCode).toBe(404);   // before the tap
    await tap();
    const photo = await app.inject({ method: 'GET', url: `/display/${t}/photo/${anna.id}` });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toContain('image/svg+xml');
    expect(photo.headers['cache-control']).toContain('no-store');
    expect((await app.inject({ method: 'GET', url: `/display/${t}/photo/${bence.id}` })).statusCode).toBe(404);   // never tapped here
    expect((await app.inject({ method: 'GET', url: `/display/wrong-key-wrong-key-wrong/photo/${anna.id}` })).statusCode).toBe(404);
  });

  it('a card tapped on another terminal can not be fetched through this one', async () => {
    const { app, adminToken, anna, tokenOf } = await setup();
    const other = await makeReader(app, adminToken, { name: 'Other' });
    await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(other.terminalToken), payload: { cardUid: UID, idempotencyKey: 'x' } });
    expect((await app.inject({ method: 'GET', url: `/display/${await tokenOf()}/photo/${anna.id}` })).statusCode).toBe(404);
  });
});

describe('the live stream', () => {
  async function connect(url: string) {
    const ctrl = new AbortController();
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const until = async (needle: string, ms = 3000) => {
      const end = Date.now() + ms;
      while (!text.includes(needle) && Date.now() < end) {
        const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>(r2 => setTimeout(() => r2({ done: true, value: undefined }), 200))]);
        if (r.value) text += dec.decode(r.value);
      }
      return text.includes(needle);
    };
    return { res, until, text: () => text, close: () => ctrl.abort() };
  }

  it('sends the state at once, then every tap as it happens', async () => {
    const { app, tap, tokenOf } = await setup();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const t = await tokenOf();
    const s = await connect(`${base}/display/${t}/events`);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-store');
    expect(await s.until('event: hello')).toBe(true);
    expect(s.text()).toContain('"name":"Gift reader"');
    await tap();
    expect(await s.until('event: tap')).toBe(true);
    expect(s.text()).toContain('+10 points');
    expect(s.text()).toContain('Anna Kovács');
    s.close();
    await app.close();
  });

  it('refuses a wrong key and more than 20 viewers of one terminal', async () => {
    const { app, reader, tokenOf } = await setup();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    expect((await fetch(`${base}/display/nope-nope-nope-nope-nope/events`)).status).toBe(404);
    for (let i = 0; i < 20; i++) app.displayHub.subscribe(reader.terminalId, () => {});
    expect((await fetch(`${base}/display/${await tokenOf()}/events`)).status).toBe(429);
    await app.close();
  });

  it('a viewer that leaves stops receiving', async () => {
    const { app, reader, tap, tokenOf } = await setup();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const before = app.displayHub.count(reader.terminalId);
    const s = await connect(`${base}/display/${await tokenOf()}/events`);
    await s.until('event: hello');
    expect(app.displayHub.count(reader.terminalId)).toBe(before + 1);
    s.close();
    await new Promise(r => setTimeout(r, 300));
    expect(app.displayHub.count(reader.terminalId)).toBe(before);
    await tap();
    await app.close();
  });
});

describe('cutting a screen off', () => {
  async function open(app: any, path: string) {
    const base = app.server.listening ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}` : await app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(base + path, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const read = async (ms: number) => {   // returns true once the server has ended the stream
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const r = await Promise.race([reader.read(), new Promise<{ done: false; value: undefined }>(r2 => setTimeout(() => r2({ done: false, value: undefined }), 150))]);
        if (r.done) return true;
        if (r.value) text += dec.decode(r.value);
      }
      return false;
    };
    return { read, text: () => text, close: () => ctrl.abort(), base };
  }

  it('a new link ends the streams that were open on the old one at once', async () => {
    const { app, adminToken, reader, tokenOf } = await setup();
    const alone = app.displayHub.count(reader.terminalId);      // the test's own listener counts as one
    const s = await open(app, `/display/${await tokenOf()}/events`);
    expect(await s.read(300)).toBe(false);
    expect(s.text()).toContain('event: hello');
    expect(app.displayHub.count(reader.terminalId)).toBe(alone + 1);
    await app.inject({ method: 'POST', url: `/terminals/${reader.terminalId}/display-link`, headers: auth(adminToken) });
    expect(await s.read(2000)).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    expect(app.displayHub.count(reader.terminalId)).toBe(alone);
    s.close(); await app.close();
  });

  it('revoking the reader ends its streams, whichever way it is revoked', async () => {
    const { app, adminToken, reader, tokenOf } = await setup();
    const a = await open(app, `/display/${await tokenOf()}/events`);
    await a.read(200);
    await app.inject({ method: 'DELETE', url: `/devices/${encodeURIComponent(reader.deviceId)}`, headers: auth(adminToken) });
    expect(await a.read(2000)).toBe(true);
    a.close();
    const other = await makeReader(app, adminToken, { name: 'Second' });
    const info = ((await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json() as any[]).find(t => t.id === other.terminalId);
    const b = await open(app, `${info.displayPath}/events`);
    await b.read(200);
    await app.inject({ method: 'DELETE', url: `/terminals/${other.terminalId}`, headers: auth(adminToken) });
    expect(await b.read(2000)).toBe(true);
    b.close(); await app.close();
  });

  it('shutting the server down is not held up by screens that are still open', async () => {
    const { app, tokenOf } = await setup();
    const s = await open(app, `/display/${await tokenOf()}/events`);
    await s.read(200);
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

describe('hardening', () => {
  it('the page carries a strict content policy and sends no referrer', async () => {
    const { app, tokenOf } = await setup();
    const page = await app.inject({ method: 'GET', url: `/display/${await tokenOf()}` });
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('a photo file that has gone missing shows the placeholder, not an error', async () => {
    const { app, db, anna, tap, tokenOf } = await setup();
    await tap();
    db.prepare("update cards set photo_path='photos/missing-file' where id=?").run(anna.id);
    const res = await app.inject({ method: 'GET', url: `/display/${await tokenOf()}/photo/${anna.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
  });
});
