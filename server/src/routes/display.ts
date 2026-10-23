import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { eventFor } from '../display.js';
import { getZone } from '../presence.js';
import { cardPhoto } from './cards.js';

const MAX_VIEWERS = 20;
const KEEP_ALIVE_MS = 20_000;
const newKey = () => randomBytes(16).toString('base64url');   // 128 bits: 22 characters

/** The terminal's display link, made the first time it is asked for. */
export function displayPathFor(db: Db, terminalId: string): string {
  const row = db.prepare('select display_token from terminals where id=?').get(terminalId) as { display_token: string | null } | undefined;
  let key = row?.display_token;
  if (!key) { key = newKey(); db.prepare('update terminals set display_token=? where id=?').run(key, terminalId); }
  return `/display/${key}`;
}

/** Hands what a tap endpoint answered to the terminal's display page, if it means something to a person. */
export function publishTap(app: FastifyInstance, terminalId: string | undefined, mode: 'fixed' | 'presence' | 'atm', answer: { status: number; body: object }) {
  if (!terminalId) return;
  const event = eventFor(answer, mode);
  if (event) app.displayHub.publish(terminalId, event);
}

/** A page for a screen next to a terminal that shows each tap live. The link's random key is its only protection. */
export function registerDisplay(app: FastifyInstance, dataDir: string) {
  const db = app.db;
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'display', 'display.html'));
  const hub = app.displayHub;

  const find = (key: string) => key.length >= 20 && key.length <= 64
    ? db.prepare('select id, name, mode, kind, zone_id, direction, display_beep from terminals where display_token=? and active=1').get(key) as
      { id: string; name: string; mode: string; kind: string; zone_id: string | null; direction: string; display_beep: number } | undefined
    : undefined;
  const stateOf = (t: NonNullable<ReturnType<typeof find>>) => ({
    name: t.name, mode: t.mode, kind: t.kind, direction: t.direction, zoneName: t.zone_id ? getZone(db, t.zone_id)?.name ?? null : null,
    beep: !!t.display_beep, last: hub.last(t.id),
  });
  const closed = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' };

  app.get('/display/:key', async (req, reply) => {
    if (!find((req.params as { key: string }).key)) return reply.code(404).send({ error: 'Not found' });
    return reply.headers(closed).type('text/html; charset=utf-8').send(page);
  });

  app.get('/display/:key/state', async (req, reply) => {
    const t = find((req.params as { key: string }).key);
    if (!t) return reply.code(404).send({ error: 'Not found' });
    return reply.headers(closed).send(stateOf(t));
  });

  app.get('/display/:key/photo/:cardId', async (req, reply) => {
    const { key, cardId } = req.params as { key: string; cardId: string };
    const t = find(key);
    if (!t || !hub.recentCardIds(t.id).has(cardId)) return reply.code(404).send({ error: 'Not found' });
    const photo = cardPhoto(db, dataDir, cardId);
    if (!photo) return reply.code(404).send({ error: 'Not found' });
    return reply.headers(closed).type(photo.type).send(photo.data);
  });

  app.get('/display/:key/events', async (req, reply) => {
    const t = find((req.params as { key: string }).key);
    if (!t) return reply.code(404).send({ error: 'Not found' });
    if (hub.count(t.id) >= MAX_VIEWERS) return reply.code(429).send({ error: 'Too many displays are open for this reader' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no', ...closed });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', stateOf(t));
    const off = hub.subscribe(t.id, e => send('tap', e));
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), KEEP_ALIVE_MS);
    req.raw.on('close', () => { clearInterval(keepAlive); off(); });
  });
}
