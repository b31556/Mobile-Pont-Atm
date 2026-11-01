import type { FastifyInstance } from 'fastify';
import { cardHistory } from '../cardinfo.js';
import { AttemptLimiter, TOO_MANY } from '../limiter.js';
import { normalizeUid } from '../uid.js';
import { cardPhoto, findCardByUid } from './cards.js';

const MAX_UIDS = 10;
const HISTORY_LINES = 200;   // enough for the program screen to add up what a card earned on each day
const MAX_INLINE_PHOTO = 600 * 1024;   // a bigger picture is left out rather than making every refresh heavy

/**
 * What a card holder sees in the "Pont Card" app: their own card by its number, read-only, no sign-in.
 * The card's number is the key (as at every reader), so lookups are limited per address, and only misses count against a tighter limit:
 * guessing numbers is what this must make pointless. Nothing here returns an internal id.
 */
export function registerPublic(app: FastifyInstance, dataDir: string) {
  const db = app.db;
  const calls = new AttemptLimiter(120, 5 * 60 * 1000);        // every request, per address
  const misses = new AttemptLimiter(30, 15 * 60 * 1000);       // numbers that are not a card, per address
  const allMisses = new AttemptLimiter(600, 60 * 60 * 1000);   // the same from everywhere

  app.post('/public/cards', async (req, reply) => {
    const ip = req.ip;
    if (calls.blocked(ip) || misses.blocked(ip) || allMisses.blocked('all')) return reply.code(429).send(TOO_MANY);
    calls.fail(ip);
    const uids = (req.body as { uids?: unknown } | undefined)?.uids;
    if (!Array.isArray(uids) || uids.length === 0 || uids.length > MAX_UIDS || !uids.every(u => typeof u === 'string' && u.length <= 40)) {
      return reply.code(400).send({ error: `Send between 1 and ${MAX_UIDS} card numbers` });
    }
    const seen = new Set<string>();
    const cards = [] as object[];
    for (const raw of uids as string[]) {
      const uid = normalizeUid(raw);
      if (uid && seen.has(uid)) continue;
      if (uid) seen.add(uid);
      const card = uid ? findCardByUid(db, uid) : undefined;
      if (!uid || !card) { misses.fail(ip); allMisses.fail('all'); cards.push({ uid: uid ?? raw, found: false }); continue; }
      const picture = card.photo_path ? cardPhoto(db, dataDir, card.id) : null;
      const photo = picture && typeof picture.data !== 'string' && picture.type.startsWith('image/') && picture.type !== 'image/svg+xml' && picture.data.length <= MAX_INLINE_PHOTO
        ? `data:${picture.type};base64,${picture.data.toString('base64')}` : null;
      cards.push({
        uid, found: true, name: card.name, status: card.status, balance: card.balance, photo,
        history: card.status === 'blocked' ? [] : cardHistory(db, card.id, HISTORY_LINES),
      });
    }
    return reply.header('cache-control', 'no-store').send({ cards });
  });
}
