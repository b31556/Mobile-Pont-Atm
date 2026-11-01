import type { Db } from './db.js';
import { DEFAULT_PROGRAM } from './program-default.js';

/**
 * The event program the Pont Card app and the program page show: days, the points goal, and the events with how each one scores.
 * It is one document stored as it is (table `program`), checked on the way in so a bad import can never break the app.
 *
 * Scoring of an event, by `model`:
 *   rate  : `rate` points per `block` minutes of staying, at most `cap` points, counting at most `maxMin` minutes
 *   tasks : a list of `items`, each with its points and the minutes it takes; staying longer finishes more of them
 *   flat  : `cap` points, only if you stay for the whole event
 */
export interface ProgramEvent {
  id: string; day: string; title: string; room: string; from: string; to: string;
  model: 'rate' | 'tasks' | 'flat';
  rate?: number; block?: number; cap?: number; maxMin?: number;
  items?: { name: string; pts: number; min: number }[];
  home?: { name: string; pts: number }[];
  kind?: 'time' | 'task' | 'mix';
  rule?: string; bonus?: string; bring?: string; note?: string; check?: string;
}
export interface ProgramDoc {
  title: string;
  days: { key: string; label: string; date: string }[];
  goal: { total: number; dayKey: string; dayMin: number };
  events: ProgramEvent[];
}

const KEY = /^[a-z0-9]{1,12}$/, ID = /^[A-Za-z0-9_-]{1,40}$/, CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const optText = (v: unknown, max: number) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.length <= max);
const realDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

/** The checked, cleaned document, or what is wrong with it (naming the event) in words an admin can act on. */
export function validateProgram(input: unknown): { doc: ProgramDoc } | { error: string } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (!text(o.title, 80)) return { error: 'The program needs a title of up to 80 characters' };
  if (!Array.isArray(o.days) || o.days.length < 1 || o.days.length > 4) return { error: 'The program needs 1 to 4 days' };
  const days: ProgramDoc['days'] = [];
  for (const d of o.days as Record<string, unknown>[]) {
    if (!d || typeof d.key !== 'string' || !KEY.test(d.key) || !text(d.label, 30) || typeof d.date !== 'string' || !realDate(d.date)) {
      return { error: 'Each day needs a short key (letters and digits), a label and a date like 2026-10-22' };
    }
    if (days.some(x => x.key === d.key)) return { error: `The day “${d.key}” is listed twice` };
    days.push({ key: d.key, label: d.label as string, date: d.date });
  }
  const g = (o.goal ?? {}) as Record<string, unknown>;
  if (!isInt(g.total, 0, 10000) || !isInt(g.dayMin, 0, 10000) || typeof g.dayKey !== 'string' || !days.some(d => d.key === g.dayKey)) {
    return { error: 'The goal needs a total, a day (one of the days) and the points needed on that day' };
  }
  if (!Array.isArray(o.events) || o.events.length > 300) return { error: 'The program needs a list of up to 300 events' };
  const events: ProgramEvent[] = [], seen = new Set<string>();
  for (const [i, raw] of (o.events as Record<string, unknown>[]).entries()) {
    const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const at = `Event ${i + 1}${typeof e.title === 'string' ? ` (${e.title.slice(0, 40)})` : ''}`;
    if (typeof e.id !== 'string' || !ID.test(e.id)) return { error: `${at}: the id needs letters, digits, - or _` };
    if (seen.has(e.id)) return { error: `${at}: the id “${e.id}” is used twice` };
    seen.add(e.id);
    if (typeof e.day !== 'string' || !days.some(d => d.key === e.day)) return { error: `${at}: the day must be one of the program's days` };
    if (!text(e.title, 100) || !text(e.room, 60)) return { error: `${at}: needs a title (up to 100) and a room (up to 60)` };
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || !CLOCK.test(e.from) || !CLOCK.test(e.to) || minutes(e.to) <= minutes(e.from)) {
      return { error: `${at}: the times must look like 08:00 and the end must be after the start` };
    }
    const out: ProgramEvent = { id: e.id, day: e.day, title: (e.title as string).trim(), room: (e.room as string).trim(), from: e.from, to: e.to, model: 'flat' };
    if (e.model === 'rate') {
      if (!isInt(e.rate, 1, 1000) || !isInt(e.block, 1, 600)) return { error: `${at}: points per time needs rate (points) and block (minutes)` };
      if (e.cap !== undefined && e.cap !== null && !isInt(e.cap, 1, 10000)) return { error: `${at}: cap must be a whole number of points` };
      if (e.maxMin !== undefined && e.maxMin !== null && !isInt(e.maxMin, 1, 1440)) return { error: `${at}: maxMin must be a whole number of minutes` };
      Object.assign(out, { model: 'rate', rate: e.rate, block: e.block });
      if (typeof e.cap === 'number') out.cap = e.cap;
      if (typeof e.maxMin === 'number') out.maxMin = e.maxMin;
    } else if (e.model === 'tasks') {
      const items = e.items;
      if (!Array.isArray(items) || items.length < 1 || items.length > 20) return { error: `${at}: needs 1 to 20 items` };
      const clean: NonNullable<ProgramEvent['items']> = [];
      for (const it of items as Record<string, unknown>[]) {
        if (!it || !text(it.name, 60) || !isInt(it.pts, 0, 1000) || !isInt(it.min, 1, 600)) return { error: `${at}: each item needs a name, points and minutes` };
        clean.push({ name: it.name as string, pts: it.pts as number, min: it.min as number });
      }
      Object.assign(out, { model: 'tasks', items: clean });
      if (Array.isArray(e.home)) {
        const home = (e.home as Record<string, unknown>[]).slice(0, 10);
        if (!home.every(h => h && text(h.name, 60) && isInt(h.pts, 0, 1000))) return { error: `${at}: each home task needs a name and points` };
        if (home.length) out.home = home.map(h => ({ name: h.name as string, pts: h.pts as number }));
      }
    } else if (e.model === 'flat') {
      if (!isInt(e.cap, 1, 10000)) return { error: `${at}: a fixed award needs its points as cap` };
      out.cap = e.cap;
    } else return { error: `${at}: model must be rate, tasks or flat` };
    if (e.kind !== undefined && e.kind !== null) {
      if (!['time', 'task', 'mix'].includes(e.kind as string)) return { error: `${at}: kind must be time, task or mix` };
      out.kind = e.kind as ProgramEvent['kind'];
    }
    for (const k of ['rule', 'bonus', 'bring', 'note', 'check'] as const) {
      if (!optText(e[k], 300)) return { error: `${at}: ${k} can be up to 300 characters` };
      if (typeof e[k] === 'string' && (e[k] as string).trim()) out[k] = (e[k] as string).trim();
    }
    events.push(out);
  }
  return { doc: { title: (o.title as string).trim(), days, goal: { total: g.total as number, dayKey: g.dayKey as string, dayMin: g.dayMin as number }, events } };
}

/** The stored program. A server that never had one starts with a small example program. */
export function loadProgram(db: Db): { doc: ProgramDoc; updatedAt: string } {
  const row = db.prepare('select json, updated_at from program where id=1').get() as { json: string; updated_at: string } | undefined;
  if (row) {
    try { return { doc: JSON.parse(row.json) as ProgramDoc, updatedAt: row.updated_at }; } catch { /* a damaged row falls back to the default below */ }
  }
  const checked = validateProgram(DEFAULT_PROGRAM);
  if ('error' in checked) throw new Error('The built-in program is invalid: ' + checked.error);
  const now = new Date().toISOString();
  db.prepare('insert or replace into program(id,json,updated_at) values(1,?,?)').run(JSON.stringify(checked.doc), now);
  return { doc: checked.doc, updatedAt: now };
}

export function saveProgram(db: Db, doc: ProgramDoc): string {
  const now = new Date().toISOString();
  db.prepare('insert or replace into program(id,json,updated_at) values(1,?,?)').run(JSON.stringify(doc), now);
  return now;
}
