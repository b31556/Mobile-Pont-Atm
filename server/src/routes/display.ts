import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { eventFor } from '../display.js';
import { AttemptLimiter, TOO_MANY } from '../limiter.js';
import { getZone } from '../presence.js';
import { cardPhoto } from './cards.js';

const COOKIE = 'pont-display';
const SESSION_SECONDS = 365 * 24 * 3600;      // a wall screen stays signed in until the code is renewed or the reader revoked
const MAX_SESSIONS = 20;                      // screens per reader
const MAX_VIEWERS = 20;
const KEEP_ALIVE_MS = 20_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The terminal's 6-digit display code, made the first time it is asked for. Unique among terminals. */
export function displayCodeFor(db: Db, terminalId: string): string {
  const row = db.prepare('select display_code from terminals where id=?').get(terminalId) as { display_code: string | null } | undefined;
  if (row?.display_code) return row.display_code;
  for (;;) {
    const code = String(randomInt(100000, 1000000));
    if (db.prepare('select 1 from terminals where display_code=?').get(code)) continue;
    db.prepare('update terminals set display_code=? where id=?').run(code, terminalId);
    return code;
  }
}

/** Makes a new code and signs out every screen that used the old one. Open live connections are hung up by the caller. */
export function renewDisplayCode(db: Db, terminalId: string): string {
  db.transaction(() => {
    db.prepare('update terminals set display_code=NULL where id=?').run(terminalId);
    db.prepare('delete from display_sessions where terminal_id=?').run(terminalId);
  })();
  return displayCodeFor(db, terminalId);
}

/** Hands what a tap endpoint answered to the terminal's display page, if it means something to a person. */
export function publishTap(app: FastifyInstance, terminalId: string | undefined, mode: 'fixed' | 'presence' | 'atm', answer: { status: number; body: object }) {
  if (!terminalId) return;
  const event = eventFor(answer, mode);
  if (event) app.displayHub.publish(terminalId, event);
}

function cookieOf(req: FastifyRequest): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * A page for a screen next to a terminal that shows each tap live. A person types the terminal's 6-digit code at
 * /display; the server then gives that screen a private session cookie, so the code never sits in the address.
 */
export function registerDisplay(app: FastifyInstance, dataDir: string) {
  const db = app.db;
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'display', 'display.html'));
  const hub = app.displayHub;
  const perAddress = new AttemptLimiter(10, 15 * 60 * 1000);   // wrong codes from one address
  const everywhere = new AttemptLimiter(300, 60 * 60 * 1000);  // wrong codes from anywhere: a 6-digit code can be guessed if this is unlimited

  type Terminal = { id: string; name: string; mode: string; kind: string; zone_id: string | null; direction: string; display_beep: number };
  const terminalOf = (req: FastifyRequest): Terminal | undefined => {
    const token = cookieOf(req);
    if (!token || token.length < 20 || token.length > 64) return undefined;
    return db.prepare(`select t.id, t.name, t.mode, t.kind, t.zone_id, t.direction, t.display_beep from display_sessions s
      join terminals t on t.id=s.terminal_id where s.token_hash=? and t.active=1`).get(sha256(token)) as Terminal | undefined;
  };
  const stateOf = (t: Terminal) => ({
    name: t.name, mode: t.mode, kind: t.kind, direction: t.direction, zoneName: t.zone_id ? getZone(db, t.zone_id)?.name ?? null : null,
    beep: !!t.display_beep, last: hub.last(t.id),
  });
  const closed = {
    'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
  app.addHook('preClose', async () => hub.closeStreams());   // open screens must not hold up a shutdown: hang them up before the server waits for connections

  app.get('/display', async (_req, reply) => reply.headers(closed).type('text/html; charset=utf-8').send(page));

  app.post('/display/enter', async (req, reply) => {
    const ip = req.ip;
    if (perAddress.blocked(ip) || everywhere.blocked('all')) return reply.code(429).headers(closed).send(TOO_MANY);
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return reply.code(400).headers(closed).send({ error: 'The code is 6 digits' });
    const t = db.prepare('select id, name, mode, kind, zone_id, direction, display_beep from terminals where display_code=? and active=1').get(code) as Terminal | undefined;
    if (!t) {
      perAddress.fail(ip); everywhere.fail('all');
      return reply.code(401).headers(closed).send({ error: 'That code is not right' });
    }
    const token = randomBytes(24).toString('base64url');
    db.transaction(() => {
      db.prepare('insert into display_sessions(token_hash, terminal_id, created_at) values(?,?,?)').run(sha256(token), t.id, new Date().toISOString());
      db.prepare(`delete from display_sessions where terminal_id=? and token_hash not in
        (select token_hash from display_sessions where terminal_id=? order by created_at desc, rowid desc limit ?)`).run(t.id, t.id, MAX_SESSIONS);
    })();
    const secure = req.protocol === 'https' ? '; Secure' : '';
    return reply.headers(closed).header('set-cookie', `${COOKIE}=${token}; Path=/display; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`).send(stateOf(t));
  });

  app.post('/display/leave', async (req, reply) => {
    const token = cookieOf(req);
    if (token) db.prepare('delete from display_sessions where token_hash=?').run(sha256(token));
    return reply.headers(closed).header('set-cookie', `${COOKIE}=; Path=/display; HttpOnly; SameSite=Strict; Max-Age=0`).send({ ok: true });
  });

  app.get('/display/state', async (req, reply) => {
    const t = terminalOf(req);
    if (!t) return reply.code(401).headers(closed).send({ error: 'Enter the code' });
    return reply.headers(closed).send(stateOf(t));
  });

  app.get('/display/photo/:cardId', async (req, reply) => {
    const t = terminalOf(req);
    const { cardId } = req.params as { cardId: string };
    if (!t) return reply.code(401).headers(closed).send({ error: 'Enter the code' });
    if (!hub.recentCardIds(t.id).has(cardId)) return reply.code(404).headers(closed).send({ error: 'Not found' });
    const photo = cardPhoto(db, dataDir, cardId);
    if (!photo) return reply.code(404).headers(closed).send({ error: 'Not found' });
    return reply.headers(closed).type(photo.type).send(photo.data);
  });

  app.get('/display/events', async (req, reply) => {
    const t = terminalOf(req);
    if (!t) return reply.code(401).headers(closed).send({ error: 'Enter the code' });
    if (hub.count(t.id) >= MAX_VIEWERS) return reply.code(429).headers(closed).send({ error: 'Too many displays are open for this reader' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no', ...closed });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', stateOf(t));
    const off = hub.subscribe(t.id, e => send('tap', e));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    const forget = hub.addStream(t.id, () => res.end());     // a new code or a revoked reader hangs this up
    req.raw.on('close', () => { clearInterval(keepAlive); off(); forget(); });
  });
}
