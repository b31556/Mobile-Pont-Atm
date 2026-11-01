import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import RealWebSocket from 'ws';
import type { WebSocket } from 'ws';
import { buildApp, type AppOptions } from '../src/app.js';
import { openDb } from '../src/db.js';
import { seedStaff } from '../src/auth.js';
import { LiveHub, changeFor, CLOSE_BUSY, CLOSE_SIGN_IN, type Topic } from '../src/live.js';
import { auth, login, makeOperator, makeReader, makeTerminal } from './helpers.js';

const SECRET = 'a-test-secret-that-is-long-enough-0123456789';

describe('which requests change something an admin page shows', () => {
  const t = (m: string, u: string, s = 200) => changeFor(m, u, s)?.topics.slice().sort() ?? null;
  it('ignores reads', () => {
    for (const u of ['/cards', '/transactions?limit=50', '/terminals', '/devices', '/zones', '/staff', '/presence/sessions', '/card-suggestions']) expect(t('GET', u)).toBeNull();
  });
  it('names the topics a write changes', () => {
    expect(t('POST', '/charges')).toEqual(['cards', 'terminals', 'transactions']);
    expect(t('POST', '/transactions/5/storno')).toEqual(['cards', 'terminals', 'transactions']);
    expect(t('POST', '/cards')).toEqual(['cards', 'transactions']);
    expect(t('PUT', '/cards/abc/photo')).toEqual(['cards', 'transactions']);
    expect(t('POST', '/cards/abc/adjust')).toEqual(['cards', 'transactions']);
    expect(t('PATCH', '/terminals/abc')).toEqual(['devices', 'terminals']);
    expect(t('POST', '/terminals/batch', 201)).toEqual(['devices', 'terminals']);
    expect(t('DELETE', '/terminals/abc')).toEqual(['devices', 'terminals']);
    expect(t('POST', '/pair')).toEqual(['devices', 'terminals']);
    expect(t('POST', '/devices/AA:BB/approve')).toEqual(['devices', 'terminals']);
    expect(t('PUT', '/zones/z1')).toEqual(['presence', 'terminals', 'zones']);
    expect(t('POST', '/presence/sessions/3/close')).toEqual(['cards', 'presence', 'transactions']);
    expect(t('DELETE', '/card-suggestions/04:00:00:01')).toEqual(['suggestions']);
    expect(t('PATCH', '/staff/s1')).toEqual(['staff']);
  });
  it('a tap counts even when the card was refused, but not when the server failed', () => {
    for (const s of [200, 403, 404, 409]) expect(t('POST', '/fixed/tap', s)).toEqual(['cards', 'presence', 'suggestions', 'terminals', 'transactions']);
    expect(t('POST', '/presence/tap', 404)).toContain('suggestions');
    expect(t('POST', '/fixed/tap', 500)).toBeNull();
  });
  it('a failed write changed nothing', () => {
    for (const s of [400, 401, 403, 404, 409, 429, 500]) expect(t('POST', '/cards', s)).toBeNull();
  });
  it('a calculation, a login and a settings save of a phone are not changes', () => {
    expect(t('POST', '/presence/preview')).toBeNull();
    expect(t('POST', '/auth/login')).toBeNull();
    expect(t('PUT', '/presets')).toBeNull();
    expect(t('POST', '/display/enter')).toBeNull();
  });
  it('heartbeats and reader hellos are throttled', () => {
    expect(changeFor('POST', '/heartbeat', 200)?.throttle).toEqual({ key: 'heartbeat', everyMs: 20_000 });
    expect(changeFor('POST', '/device/hello', 200)?.throttle?.key).toBe('hello');
    expect(changeFor('POST', '/charges', 200)?.throttle).toBeUndefined();
  });
});

describe('LiveHub batching and throttling', () => {
  afterEach(() => vi.useRealTimers());
  function fakeSocket() {
    const s = new EventEmitter() as EventEmitter & { sent: string[]; bufferedAmount: number; send(m: string): void; close(): void; terminate(): void; ping(): void };
    s.sent = []; s.bufferedAmount = 0;
    s.send = m => { s.sent.push(m); }; s.close = () => { s.emit('close'); }; s.terminate = () => { s.emit('close'); }; s.ping = () => {};
    return s;
  }
  function hubWithClient() {
    const hub = new LiveHub({ flushMs: 100 });
    const sock = fakeSocket();
    const conn = hub.add(sock as unknown as WebSocket, '1.1.1.1')!;
    conn.staffId = 'admin-1';
    const got = () => sock.sent.map(m => JSON.parse(m) as { type: string; topics: Topic[] });
    return { hub, sock, got };
  }

  it('changes that arrive together go out as one message', () => {
    vi.useFakeTimers();
    const { hub, got } = hubWithClient();
    hub.notify(['cards']); hub.notify(['transactions', 'cards']); hub.notify(['zones']);
    expect(got()).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(got()).toHaveLength(1);
    expect(got()[0].topics.sort()).toEqual(['cards', 'transactions', 'zones']);
    hub.stop();
  });

  it('does not send to a connection that has not signed in', () => {
    vi.useFakeTimers();
    const hub = new LiveHub();
    const sock = fakeSocket();
    hub.add(sock as unknown as WebSocket, '1.1.1.1');
    hub.notify(['cards']); vi.advanceTimersByTime(500);
    expect(sock.sent).toHaveLength(0);
    hub.stop();
  });

  it('a throttled source goes out at once, then at most once per period with everything it held', () => {
    vi.useFakeTimers();
    const { hub, got } = hubWithClient();
    const th = { key: 'heartbeat', everyMs: 20_000 };
    hub.notify(['terminals'], th); vi.advanceTimersByTime(100);
    expect(got()).toHaveLength(1);                         // the first one is immediate
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(1000); hub.notify(['terminals'], th); }
    hub.notify(['devices'], th);
    vi.advanceTimersByTime(5000);
    expect(got()).toHaveLength(1);                         // 15 s in: still held back
    vi.advanceTimersByTime(5100);                          // 20 s after the first
    expect(got()).toHaveLength(2);
    expect(got()[1].topics.sort()).toEqual(['devices', 'terminals']);
    vi.advanceTimersByTime(60_000);
    expect(got()).toHaveLength(2);                         // nothing more was pending
    hub.stop();
  });

  it('a throttled source does not hold back an unthrottled change', () => {
    vi.useFakeTimers();
    const { hub, got } = hubWithClient();
    hub.notify(['terminals'], { key: 'hb', everyMs: 20_000 }); vi.advanceTimersByTime(100);
    hub.notify(['terminals'], { key: 'hb', everyMs: 20_000 });
    hub.notify(['cards']); vi.advanceTimersByTime(100);
    expect(got().map(m => m.topics)).toEqual([['terminals'], ['cards']]);
    hub.stop();
  });

  it('hangs up a client that does not read', () => {
    vi.useFakeTimers();
    const { hub, sock } = hubWithClient();
    sock.bufferedAmount = 5_000_000;
    let closed = false; sock.on('close', () => { closed = true; });
    hub.notify(['cards']); vi.advanceTimersByTime(100);
    expect(closed).toBe(true);
    expect(hub.size).toBe(0);
    hub.stop();
  });

  it('limits waiting connections per address and in total', () => {
    const hub = new LiveHub();
    for (let i = 0; i < 10; i++) expect(hub.add(fakeSocket() as unknown as WebSocket, '9.9.9.9')).not.toBeNull();
    expect(hub.add(fakeSocket() as unknown as WebSocket, '9.9.9.9')).toBeNull();
    expect(hub.add(fakeSocket() as unknown as WebSocket, '8.8.8.8')).not.toBeNull();
    hub.stop();
  });
});

// ---- the endpoint, through a real Fastify app ----

const apps: { close(): Promise<undefined> }[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => { for (const s of sockets.splice(0)) { try { s.terminate(); } catch { /* closed */ } } for (const a of apps.splice(0)) await a.close(); });

async function makeLiveApp(extra: Partial<AppOptions> = {}) {
  const db = openDb(':memory:');
  const app = buildApp({ db, jwtSecret: SECRET, dataDir: mkdtempSync(join(tmpdir(), 'pont-')), ...extra });
  apps.push(app);
  await app.ready();
  const id = seedStaff(db, { name: 'Admin', email: 'admin@pont.example', password: 'adminpass', role: 'admin' });
  // Signed directly, so an app that insists on https (which refuses even a login over plain http) can be tested too.
  const adminToken = app.jwt.sign({ kind: 'staff', id, role: 'admin', v: 0 }, { expiresIn: 3600 });
  return { app, db, adminToken };
}
type TestApp = Awaited<ReturnType<typeof makeLiveApp>>['app'];

/** A WebSocket client that remembers what it was sent, so a test can wait for the next message or check that none came. */
async function connect(app: TestApp, upgrade?: { headers?: Record<string, string> }, opts?: { silent?: boolean }) {
  const ws = (await app.injectWS('/ws', upgrade)) as unknown as WebSocket;
  if (opts?.silent) ws.pong = () => {};   // a client that never answers the server's pings
  sockets.push(ws);
  const queue: { type: string; topics?: Topic[]; error?: string }[] = [];
  const waiters: ((m: (typeof queue)[number]) => void)[] = [];
  ws.on('message', d => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  const closed = new Promise<number>(res => ws.on('close', code => res(code)));
  const next = (ms = 1500) => queue.length ? Promise.resolve(queue.shift()!) : new Promise<(typeof queue)[number]>((res, rej) => {
    const t = setTimeout(() => rej(new Error('no message arrived')), ms);
    waiters.push(m => { clearTimeout(t); res(m); });
  });
  const quiet = async (ms = 350) => { await new Promise(r => setTimeout(r, ms)); expect(queue).toEqual([]); };
  const send = (o: unknown) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
  const signIn = async (token: string) => { send({ type: 'auth', token }); return next(); };
  return { ws, next, quiet, send, closed, signIn };
}
const withTimeout = <T>(p: Promise<T>, ms = 1500) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('did not happen in time')), ms))]);

describe('the /ws endpoint', () => {
  it('an admin signs in and is greeted', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    expect(await c.signIn(adminToken)).toEqual({ type: 'hello' });
  });

  it('tells a signed-in admin what a change touched, and nothing for a read', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    await app.inject({ method: 'GET', url: '/cards', headers: auth(adminToken) });
    await app.inject({ method: 'GET', url: '/transactions', headers: auth(adminToken) });
    await c.quiet();
    const res = await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'Anna', uid: '04A23B1C' } });
    expect(res.statusCode).toBe(201);
    const m = await c.next();
    expect(m.type).toBe('changed');
    expect(m.topics!.sort()).toEqual(['cards', 'transactions']);
    await c.quiet();
  });

  it('every open page gets it', async () => {
    const { app, adminToken } = await makeLiveApp();
    const a = await connect(app), b = await connect(app);
    await a.signIn(adminToken); await b.signIn(adminToken);
    await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym' } });
    expect((await a.next()).topics).toContain('zones');
    expect((await b.next()).topics).toContain('zones');
  });

  it('changes made at the same moment arrive as one message', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    await Promise.all([
      app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: 'A', uid: '04A23B1C' } }),
      app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym' } }),
    ]);
    const m = await c.next();
    expect(m.topics!.sort()).toEqual(['cards', 'presence', 'terminals', 'transactions', 'zones']);
    await c.quiet();
  });

  it('a failed change sends nothing', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    expect((await app.inject({ method: 'POST', url: '/cards', headers: auth(adminToken), payload: { name: '', uid: 'nope' } })).statusCode).toBe(400);
    await c.quiet();
  });

  it('a tap on a reader, even by an unregistered card, reaches the admin', async () => {
    const { app, adminToken } = await makeLiveApp();
    const reader = await makeReader(app, adminToken);
    await new Promise(r => setTimeout(r, 250));   // let the messages from making the reader go out first
    const c = await connect(app);
    await c.signIn(adminToken);
    await c.quiet(300);
    const tap = await app.inject({ method: 'POST', url: '/fixed/tap', headers: auth(reader.terminalToken), payload: { cardUid: '04:00:00:01', idempotencyKey: 'k1' } });
    expect(tap.statusCode).toBe(404);
    expect((await c.next()).topics).toContain('suggestions');
  });

  it('a new reader showing up is pushed straight away', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    const hello = await app.inject({ method: 'POST', url: '/device/hello', payload: { deviceId: 'AA:BB:CC:00:11:22', secret: 'a-long-enough-secret-123', firmware: '1.0.0' } });
    expect(hello.statusCode).toBe(200);
    expect((await c.next()).topics).toContain('devices');
  });

  it('refuses a wrong, missing or foreign token, and closes the connection', async () => {
    const { app, db, adminToken } = await makeLiveApp();
    const op = await makeOperator(app, db);
    const phone = makeTerminal(app, db);
    for (const token of ['garbage', '', op.token, phone.terminalToken, adminToken + 'x']) {
      const c = await connect(app);
      c.send({ type: 'auth', token });
      expect(await withTimeout(c.closed)).toBe(CLOSE_SIGN_IN);
    }
  });

  it('refuses a token of a switched-off admin', async () => {
    const { app, db, adminToken } = await makeLiveApp();
    seedStaff(db, { name: 'Other', email: 'other@pont.example', password: 'pw123456', role: 'admin' });
    const other = await login(app, 'other@pont.example', 'pw123456');
    const id = (db.prepare("select id from staff where email='other@pont.example'").get() as { id: string }).id;
    await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { active: false } });
    const c = await connect(app);
    c.send({ type: 'auth', token: other });
    expect(await withTimeout(c.closed)).toBe(CLOSE_SIGN_IN);
  });

  it('hangs up an open page when that person’s sign-in is revoked, and leaves the others', async () => {
    const { app, db, adminToken } = await makeLiveApp();
    seedStaff(db, { name: 'Other', email: 'other@pont.example', password: 'pw123456', role: 'admin' });
    const other = await login(app, 'other@pont.example', 'pw123456');
    const id = (db.prepare("select id from staff where email='other@pont.example'").get() as { id: string }).id;
    const mine = await connect(app), theirs = await connect(app);
    await mine.signIn(adminToken); await theirs.signIn(other);
    await app.inject({ method: 'PATCH', url: `/staff/${id}`, headers: auth(adminToken), payload: { password: 'brand-new-pw' } });
    expect(await withTimeout(theirs.closed)).toBe(CLOSE_SIGN_IN);
    await app.inject({ method: 'POST', url: '/zones', headers: auth(adminToken), payload: { name: 'Gym' } });
    expect((await mine.next()).type).toBe('changed');   // the other admin's page is still live
  });

  it('closes the connection when the token runs out', async () => {
    const { app, db } = await makeLiveApp();
    const id = (db.prepare("select id from staff where email='admin@pont.example'").get() as { id: string }).id;
    const short = app.jwt.sign({ kind: 'staff', id, role: 'admin', v: 0 }, { expiresIn: 1 });
    const c = await connect(app);
    expect(await c.signIn(short)).toEqual({ type: 'hello' });
    expect(await withTimeout(c.closed, 2500)).toBe(CLOSE_SIGN_IN);
  });

  it('ignores anything before signing in: a connection that does not sign in first is closed', async () => {
    const { app } = await makeLiveApp();
    const a = await connect(app);
    a.send({ type: 'ping' });
    expect(await withTimeout(a.closed)).toBe(CLOSE_SIGN_IN);
    const b = await connect(app);
    b.send('not json');
    expect(await withTimeout(b.closed)).toBe(1003);
  });

  it('closes a connection that never signs in', async () => {
    const { app } = await makeLiveApp({ live: { authTimeoutMs: 150 } });
    const c = await connect(app);
    expect(await withTimeout(c.closed)).toBe(CLOSE_SIGN_IN);
  });

  it('answers a ping, ignores other messages, and refuses oversized and binary ones', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    c.send({ type: 'ping' });
    expect(await c.next()).toEqual({ type: 'pong' });
    c.send({ type: 'subscribe', topics: ['everything'] });
    c.send({ type: 'auth', token: 'again' });
    await c.quiet(200);
    c.send(JSON.stringify({ type: 'x', pad: 'a'.repeat(5000) }));
    expect(await withTimeout(c.closed)).toBe(1009);
    const b = await connect(app);
    await b.signIn(adminToken);
    b.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await withTimeout(b.closed)).toBe(1003);
  });

  it('allows ten open pages per person and refuses the eleventh', async () => {
    const { app, adminToken } = await makeLiveApp();
    for (let i = 0; i < 10; i++) { const c = await connect(app); expect(await c.signIn(adminToken)).toEqual({ type: 'hello' }); }
    const extra = await connect(app);
    extra.send({ type: 'auth', token: adminToken });
    expect(await withTimeout(extra.closed)).toBe(CLOSE_BUSY);
  });

  it('hangs up a client that stops answering pings', async () => {
    const { app, adminToken } = await makeLiveApp({ live: { pingMs: 60 } });
    const c = await connect(app, undefined, { silent: true });
    await c.signIn(adminToken);
    await withTimeout(c.closed, 1500);
  });

  it('closes open pages when the server shuts down', async () => {
    const { app, adminToken } = await makeLiveApp();
    const c = await connect(app);
    await c.signIn(adminToken);
    const closed = c.closed;
    await app.close();
    expect(await withTimeout(closed)).toBe(1001);
  });

  it('only accepts a browser connection from its own page', async () => {
    const { app } = await makeLiveApp();
    await expect(app.injectWS('/ws', { headers: { host: 'pont.test', origin: 'https://evil.example' } })).rejects.toThrow(/403/);
    await expect(app.injectWS('/ws', { headers: { host: 'pont.test', origin: 'not a url' } })).rejects.toThrow(/403/);
    const ok = (await app.injectWS('/ws', { headers: { host: 'pont.test', origin: 'https://pont.test' } })) as unknown as WebSocket;
    sockets.push(ok);
    expect(ok.readyState).toBe(1);
  });

  it('follows the https-only rule over a real connection: refused over plain http, accepted when the trusted proxy says https', async () => {
    // A real socket is needed: the in-process test client has no connection, so Fastify cannot tell the protocol or the proxy.
    const { app, adminToken } = await makeLiveApp({ trustProxy: 'loopback', requireHttps: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const open = (headers: Record<string, string>) => new Promise<WebSocket | number>(resolve => {
      const ws = new RealWebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.on('open', () => { sockets.push(ws as unknown as WebSocket); resolve(ws as unknown as WebSocket); });
      ws.on('unexpected-response', (req, res) => { const code = res.statusCode ?? 0; res.resume(); req.destroy(); resolve(code); });
      ws.on('error', () => { /* reported through 'unexpected-response' */ });
    });
    expect(await open({})).toBe(426);                                           // nginx would always add the header, so this is a direct plain-http client
    // A refused upgrade must not leave its connection open (it used to: that leaked a socket per attempt and held up shutdown).
    await new Promise(r => setTimeout(r, 200));
    expect(await new Promise<number>(r => app.server.getConnections((_e, n) => r(n)))).toBe(0);
    const ws = await open({ 'x-forwarded-proto': 'https' });
    expect(typeof ws).toBe('object');
    const hello = new Promise<string>(res => (ws as WebSocket).once('message', d => res(d.toString())));
    (ws as WebSocket).send(JSON.stringify({ type: 'auth', token: adminToken }));
    expect(JSON.parse(await withTimeout(hello))).toEqual({ type: 'hello' });
  });
});
