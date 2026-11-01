import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.js';
import { stamp } from '../clock.js';
import { normalizeUid } from '../uid.js';
import { avatarSvg, STYLES } from '../avatar.js';
import { cardReport } from '../report.js';

export interface CardRow {
  id: string; name: string; uid: string; balance: number; status: 'active' | 'blocked';
  photo_style: number; photo_path: string | null; last_used: string | null;
}

export const findCardByUid = (db: Db, uid: string) =>
  db.prepare('select * from cards where uid=?').get(uid) as CardRow | undefined;

export const cardJson = (c: CardRow) => ({
  id: c.id, name: c.name, uid: c.uid, balance: c.balance, status: c.status,
  photoStyle: c.photo_style, hasPhoto: !!c.photo_path, lastUsed: c.last_used, photoUrl: `/cards/${c.id}/photo`,
});

function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** The picture to show for a card: the uploaded photo, or the generated placeholder. Null if there is no such card. */
export function cardPhoto(db: Db, dataDir: string, cardId: string): { type: string; data: Buffer | string } | null {
  const card = db.prepare('select * from cards where id=?').get(cardId) as CardRow | undefined;
  if (!card) return null;
  if (card.photo_path) {
    try {
      const data = readFileSync(join(dataDir, card.photo_path));
      return { type: sniffImage(data) ?? 'application/octet-stream', data };
    } catch { /* the file has gone missing: show the placeholder instead of an error */ }
  }
  return { type: 'image/svg+xml', data: avatarSvg(card.photo_style) };
}

export const MAX_IMPORT = 1000;                 // cards in one import
const MAX_NAME = 100;
const MAX_POINTS = 1_000_000;

export interface ImportRow { name: string; uid: string; points: number }
export interface ImportResult { index: number; ok: boolean; error?: string; uid?: string }

/**
 * Checks a pasted list of cards against the rules for one card and against each other and the cards that exist.
 * Returns one result per row (in order) and, when every row is fine, the cleaned rows ready to be saved.
 */
export function checkImport(db: Db, input: unknown): { results: ImportResult[]; rows: ImportRow[] | null } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: 'Paste at least one card' };
  if (input.length > MAX_IMPORT) return { error: `Up to ${MAX_IMPORT} cards at a time` };
  // Rows may say which line of the pasted list they came from, so a message can point at what the person sees.
  const where = (i: number) => { const line = (input[i] as { line?: unknown } | null)?.line; return typeof line === 'number' && Number.isInteger(line) && line > 0 ? `line ${line}` : `row ${i + 1}`; };
  const firstSeen = new Map<string, number>();
  const rows: ImportRow[] = [];
  const results = input.map((raw, index): ImportResult => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; uid?: unknown; points?: unknown };
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) return { index, ok: false, error: 'Add the holder’s name' };
    if (name.length > MAX_NAME) return { index, ok: false, error: `The name can be up to ${MAX_NAME} characters` };
    const uid = typeof r.uid === 'string' ? normalizeUid(r.uid) : null;
    if (!uid) return { index, ok: false, error: 'That is not a valid card UID' };
    const points = r.points === undefined || r.points === null ? 0 : r.points;
    if (typeof points !== 'number' || !Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
      return { index, ok: false, uid, error: `Starting points must be a whole number from 0 to ${MAX_POINTS}` };
    }
    const earlier = firstSeen.get(uid);
    if (earlier !== undefined) return { index, ok: false, uid, error: `The same card UID as ${where(earlier)}` };
    firstSeen.set(uid, index);
    const existing = findCardByUid(db, uid);
    if (existing) return { index, ok: false, uid, error: `That UID is already on a card (${existing.name})` };
    rows.push({ name, uid, points });
    return { index, ok: true, uid };
  });
  return { results, rows: results.every(x => x.ok) ? rows : null };
}

export function registerCards(app: FastifyInstance, dataDir: string) {
  const db = app.db;
  const get = (id: string) => db.prepare('select * from cards where id=?').get(id) as CardRow | undefined;

  app.get('/cards', { preHandler: app.requireAdmin }, async req => {
    const q = String(((req.query ?? {}) as { q?: string }).q ?? '').trim().toLowerCase();
    const rows = db.prepare('select * from cards order by name').all() as CardRow[];
    return rows.filter(c => !q || c.name.toLowerCase().includes(q) || c.uid.toLowerCase().includes(q)).map(cardJson);
  });

  app.post('/cards', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; uid?: string; points?: number; photoStyle?: number };
    const uid = normalizeUid(b.uid ?? '');
    if (!b.name?.trim()) return reply.code(400).send({ error: 'Add the holder’s name' });
    if (!uid) return reply.code(400).send({ error: 'That is not a valid card UID' });
    const points = b.points ?? 0;
    if (!Number.isInteger(points) || points < 0) return reply.code(400).send({ error: 'Starting points must be 0 or more' });
    if (findCardByUid(db, uid)) return reply.code(409).send({ error: 'That UID is already on a card' });
    const id = randomUUID();
    const name = b.name.trim();
    const style = Number.isInteger(b.photoStyle) ? b.photoStyle! : (db.prepare('select count(*) c from cards').get() as { c: number }).c % STYLES.length;
    db.transaction(() => {
      db.prepare('insert into cards(id,name,uid,balance,status,photo_style) values(?,?,?,?,?,?)').run(id, name, uid, points, 'active', style);
      db.prepare('delete from card_suggestions where uid=?').run(uid);
    })();
    return reply.code(201).send(cardJson(get(id)!));
  });

  /** Dry run for the import page: says what is wrong with which row, and saves nothing. */
  app.post('/cards/import/check', { preHandler: app.requireAdmin }, async (req, reply) => {
    const checked = checkImport(db, ((req.body ?? {}) as { rows?: unknown }).rows);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    return { ok: checked.rows !== null, results: checked.results };
  });

  /** Makes all the cards of a pasted list, or none if any row has a problem. Photos are sent afterwards, one per card. */
  app.post('/cards/import', { preHandler: app.requireAdmin }, async (req, reply) => {
    const checked = checkImport(db, ((req.body ?? {}) as { rows?: unknown }).rows);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    if (!checked.rows) return reply.code(400).send({ error: 'Some rows have a problem, so no card was made', results: checked.results });
    const rows = checked.rows;
    const created = db.transaction(() => {
      let style = (db.prepare('select count(*) c from cards').get() as { c: number }).c;
      return rows.map((r, index) => {
        const id = randomUUID();
        db.prepare('insert into cards(id,name,uid,balance,status,photo_style) values(?,?,?,?,?,?)').run(id, r.name, r.uid, r.points, 'active', style++ % STYLES.length);
        db.prepare('delete from card_suggestions where uid=?').run(r.uid);
        return { index, id, uid: r.uid };
      });
    })();
    return reply.code(201).send({ created });
  });

  app.patch('/cards/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = get(id);
    if (!card) return reply.code(404).send({ error: 'Card not found' });
    const b = (req.body ?? {}) as { name?: string; uid?: string; status?: string; photoStyle?: number };
    const set: string[] = []; const vals: unknown[] = [];
    if (b.name !== undefined) { if (!b.name.trim()) return reply.code(400).send({ error: 'Add the holder’s name' }); set.push('name=?'); vals.push(b.name.trim()); }
    if (b.uid !== undefined) {
      const uid = normalizeUid(b.uid);
      if (!uid) return reply.code(400).send({ error: 'That is not a valid card UID' });
      const other = findCardByUid(db, uid);
      if (other && other.id !== id) return reply.code(409).send({ error: 'That UID is already on a card' });
      set.push('uid=?'); vals.push(uid);
      db.prepare('delete from card_suggestions where uid=?').run(uid);
    }
    if (b.status !== undefined) { if (!['active', 'blocked'].includes(b.status)) return reply.code(400).send({ error: 'Bad status' }); set.push('status=?'); vals.push(b.status); }
    if (b.photoStyle !== undefined && Number.isInteger(b.photoStyle)) { set.push('photo_style=?'); vals.push(b.photoStyle); }
    if (set.length) db.prepare(`update cards set ${set.join(',')} where id=?`).run(...vals, id);
    return cardJson(get(id)!);
  });

  app.post('/cards/:id/adjust', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { delta?: number; reason?: unknown };
    const delta = body.delta;
    const card = get(id);
    if (!card) return reply.code(404).send({ error: 'Card not found' });
    if (!Number.isInteger(delta) || delta === 0) return reply.code(400).send({ error: 'Enter a whole number, not 0' });
    if (card.balance + delta! < 0) return reply.code(400).send({ error: 'Balance can’t go below 0' });
    if (body.reason !== undefined && body.reason !== null && (typeof body.reason !== 'string' || body.reason.trim().length > 200)) {
      return reply.code(400).send({ error: 'The reason must be text of up to 200 characters' });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
    db.transaction(() => {
      db.prepare('update cards set balance=balance+? where id=?').run(delta, id);
      db.prepare('insert into balance_adjustments(id,card_id,delta,staff_id,created_at,balance_after,reason) values(?,?,?,?,?,?,?)')
        .run(randomUUID(), id, delta, req.user.id, stamp().toISOString(), card.balance + delta!, reason);
    })();
    return cardJson(get(id)!);
  });

  app.put('/cards/:id/photo', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!get(id)) return reply.code(404).send({ error: 'Card not found' });
    let data: Buffer;
    try {
      const file = await req.file();
      if (!file) return reply.code(400).send({ error: 'Choose a photo to upload' });
      data = await file.toBuffer();
      if (file.file.truncated) return reply.code(400).send({ error: 'Photo is larger than 2 MB' });
    } catch { return reply.code(400).send({ error: 'Photo is larger than 2 MB' }); }
    const type = sniffImage(data);
    if (!type) return reply.code(400).send({ error: 'Use a JPEG, PNG or WebP photo' });
    mkdirSync(join(dataDir, 'photos'), { recursive: true });
    const path = join('photos', id);
    writeFileSync(join(dataDir, path), data);
    db.prepare('update cards set photo_path=? where id=?').run(path, id);
    return cardJson(get(id)!);
  });

  /** Everything that happened to one card, for the admin's report page: visits, grants, refunds, adjustments and totals. */
  app.get('/cards/:id/report', { preHandler: app.requireAdmin }, async (req, reply) => {
    const report = cardReport(db, (req.params as { id: string }).id);
    if (!report) return reply.code(404).send({ error: 'Card not found' });
    return reply.header('cache-control', 'no-store').send(report);
  });

  app.get('/cards/:id/photo', { preHandler: app.requireStaff }, async (req, reply) => {
    const photo = cardPhoto(db, dataDir, (req.params as { id: string }).id);
    if (!photo) return reply.code(404).send({ error: 'Card not found' });
    return reply.type(photo.type).header('cache-control', 'private, max-age=300').send(photo.data);
  });
}
