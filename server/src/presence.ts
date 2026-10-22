import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export type Rounding = 'down' | 'up' | 'nearest' | 'prorata';
export const ROUNDINGS: Rounding[] = ['down', 'up', 'nearest', 'prorata'];

export interface PresenceSettings {
  pointsPerBlock: number;
  blockMinutes: number;
  rounding: Rounding;
  minMinutes: number;
  maxPointsVisit: number | null;
  maxPoints24h: number | null;
  maxStayHours: number;
  cooldownSeconds: number;
}

export const DEFAULT_SETTINGS: PresenceSettings = {
  pointsPerBlock: 8, blockMinutes: 12, rounding: 'down', minMinutes: 0,
  maxPointsVisit: null, maxPoints24h: null, maxStayHours: 12, cooldownSeconds: 30,
};

const RANGES = {
  pointsPerBlock: [1, 1000], blockMinutes: [1, 1440], minMinutes: [0, 1440],
  maxStayHours: [1, 72], cooldownSeconds: [0, 600],
} as const;
const CAP_RANGE = [1, 100000] as const;

export function validateSettings(input: unknown): { ok: true; value: PresenceSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Settings must be an object' };
  const o = input as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  for (const [field, [lo, hi]] of Object.entries(RANGES)) {
    if (!int(o[field], lo, hi)) return { ok: false, error: `${field} must be a whole number from ${lo} to ${hi}` };
  }
  for (const field of ['maxPointsVisit', 'maxPoints24h'] as const) {
    if (o[field] !== null && !int(o[field], CAP_RANGE[0], CAP_RANGE[1])) return { ok: false, error: `${field} must be empty or a whole number from ${CAP_RANGE[0]} to ${CAP_RANGE[1]}` };
  }
  if (!ROUNDINGS.includes(o.rounding as Rounding)) return { ok: false, error: `rounding must be one of ${ROUNDINGS.join(', ')}` };
  return { ok: true, value: {
    pointsPerBlock: o.pointsPerBlock as number, blockMinutes: o.blockMinutes as number, rounding: o.rounding as Rounding,
    minMinutes: o.minMinutes as number, maxPointsVisit: o.maxPointsVisit as number | null, maxPoints24h: o.maxPoints24h as number | null,
    maxStayHours: o.maxStayHours as number, cooldownSeconds: o.cooldownSeconds as number,
  } };
}

/**
 * Points for a visit of [minutes] whole minutes. Integer arithmetic only, so half a block rounds up exactly.
 * The per-visit cap applies first, then what is left of the 24 h allowance (null = no limit).
 */
export function computePoints(s: PresenceSettings, minutes: number, remaining24h: number | null): { raw: number; awarded: number; cappedBy: null | 'visit' | '24h' } {
  const { pointsPerBlock: p, blockMinutes: b } = s;
  let raw = 0;
  if (minutes >= s.minMinutes && minutes > 0) {
    if (s.rounding === 'down') raw = Math.floor(minutes / b) * p;
    else if (s.rounding === 'up') raw = Math.ceil(minutes / b) * p;
    else if (s.rounding === 'nearest') raw = Math.floor((2 * minutes + b) / (2 * b)) * p;
    else raw = Math.floor((2 * minutes * p + b) / (2 * b));
  }
  let awarded = raw;
  let cappedBy: null | 'visit' | '24h' = null;
  if (s.maxPointsVisit !== null && awarded > s.maxPointsVisit) { awarded = s.maxPointsVisit; cappedBy = 'visit'; }
  if (remaining24h !== null && awarded > remaining24h) { awarded = Math.max(0, remaining24h); cappedBy = '24h'; }
  return { raw, awarded, cappedBy };
}

export interface Zone { id: string; name: string; settings: PresenceSettings }

function zoneFromRow(row: Record<string, unknown>): Zone {
  return {
    id: row.id as string, name: row.name as string,
    settings: {
      pointsPerBlock: row.points_per_block as number, blockMinutes: row.block_minutes as number, rounding: row.rounding as Rounding,
      minMinutes: row.min_minutes as number, maxPointsVisit: row.max_points_visit as number | null, maxPoints24h: row.max_points_24h as number | null,
      maxStayHours: row.max_stay_hours as number, cooldownSeconds: row.cooldown_seconds as number,
    },
  };
}

export const listZones = (db: Db): Zone[] =>
  (db.prepare('select * from zones order by created_at, rowid').all() as Record<string, unknown>[]).map(zoneFromRow);

export function getZone(db: Db, id: string): Zone | undefined {
  const row = db.prepare('select * from zones where id=?').get(id) as Record<string, unknown> | undefined;
  return row ? zoneFromRow(row) : undefined;
}

/** The first zone made. Always exists. */
export const defaultZone = (db: Db): Zone => listZones(db)[0];

export function createZone(db: Db, name: string, s: PresenceSettings): Zone {
  const id = randomUUID();
  db.prepare(`insert into zones(id,name,created_at,points_per_block,block_minutes,rounding,min_minutes,max_points_visit,max_points_24h,max_stay_hours,cooldown_seconds)
    values(?,?,?,?,?,?,?,?,?,?,?)`).run(id, name, new Date().toISOString(), s.pointsPerBlock, s.blockMinutes, s.rounding, s.minMinutes, s.maxPointsVisit, s.maxPoints24h, s.maxStayHours, s.cooldownSeconds);
  return getZone(db, id)!;
}

export function updateZone(db: Db, id: string, change: { name?: string; settings?: PresenceSettings }): Zone | undefined {
  const zone = getZone(db, id);
  if (!zone) return undefined;
  const name = change.name ?? zone.name, s = change.settings ?? zone.settings;
  db.prepare(`update zones set name=?, points_per_block=?, block_minutes=?, rounding=?, min_minutes=?, max_points_visit=?, max_points_24h=?, max_stay_hours=?, cooldown_seconds=? where id=?`)
    .run(name, s.pointsPerBlock, s.blockMinutes, s.rounding, s.minMinutes, s.maxPointsVisit, s.maxPoints24h, s.maxStayHours, s.cooldownSeconds, id);
  return getZone(db, id);
}
