import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { DEFAULT_SETTINGS, computePoints, getSettings, saveSettings, validateSettings, type PresenceSettings } from '../src/presence.js';

const s = (over: Partial<PresenceSettings> = {}): PresenceSettings => ({ ...DEFAULT_SETTINGS, ...over });
const minutes = [5, 12, 17, 18, 30, 50];
const awarded = (settings: PresenceSettings) => minutes.map(m => computePoints(settings, m, null).awarded);

describe('computePoints, 8 points per 12 minutes', () => {
  it('defaults are 8 per 12 minutes, rounded down, no caps', () => {
    expect(DEFAULT_SETTINGS).toEqual({ pointsPerBlock: 8, blockMinutes: 12, rounding: 'down', minMinutes: 0, maxPointsVisit: null, maxPoints24h: null, maxStayHours: 12, cooldownSeconds: 30 });
  });
  it('down counts only whole blocks', () => expect(awarded(s({ rounding: 'down' }))).toEqual([0, 8, 8, 8, 16, 32]));
  it('up counts any started block', () => expect(awarded(s({ rounding: 'up' }))).toEqual([8, 8, 16, 16, 24, 40]));
  it('nearest rounds half a block up', () => expect(awarded(s({ rounding: 'nearest' }))).toEqual([0, 8, 8, 16, 24, 32]));
  it('prorata pays minute by minute, rounded to whole points', () => expect(awarded(s({ rounding: 'prorata' }))).toEqual([3, 8, 11, 12, 20, 33]));
  it('zero minutes earn nothing in every mode', () => {
    for (const rounding of ['down', 'up', 'nearest', 'prorata'] as const) expect(computePoints(s({ rounding }), 0, null).awarded).toBe(0);
  });
  it('other rates work: 5 points per 10 minutes, up', () => expect(computePoints(s({ pointsPerBlock: 5, blockMinutes: 10, rounding: 'up' }), 21, null).awarded).toBe(15));
});

describe('computePoints, limits', () => {
  it('under the minimum minutes earns nothing, even when rounding up', () => {
    expect(computePoints(s({ minMinutes: 10, rounding: 'up' }), 9, null)).toEqual({ raw: 0, awarded: 0, cappedBy: null });
    expect(computePoints(s({ minMinutes: 10, rounding: 'up' }), 10, null).awarded).toBe(8);
  });
  it('the per-visit cap reduces and says so', () => {
    expect(computePoints(s({ maxPointsVisit: 20 }), 50, null)).toEqual({ raw: 32, awarded: 20, cappedBy: 'visit' });
  });
  it('a cap above the earned amount does nothing', () => {
    expect(computePoints(s({ maxPointsVisit: 100 }), 50, null)).toEqual({ raw: 32, awarded: 32, cappedBy: null });
  });
  it('what is left of the 24 h allowance reduces and says so', () => {
    expect(computePoints(s(), 50, 5)).toEqual({ raw: 32, awarded: 5, cappedBy: '24h' });
  });
  it('an exhausted 24 h allowance earns nothing', () => {
    expect(computePoints(s(), 50, 0)).toEqual({ raw: 32, awarded: 0, cappedBy: '24h' });
  });
  it('both caps: the visit cap applies first, the label is the one that cut last', () => {
    expect(computePoints(s({ maxPointsVisit: 20 }), 50, 12)).toEqual({ raw: 32, awarded: 12, cappedBy: '24h' });
    expect(computePoints(s({ maxPointsVisit: 10 }), 50, 12)).toEqual({ raw: 32, awarded: 10, cappedBy: 'visit' });
  });
  it('never returns negative points if the allowance is somehow overdrawn', () => {
    expect(computePoints(s(), 50, -3).awarded).toBe(0);
  });
});

describe('validateSettings', () => {
  it('accepts the defaults', () => expect(validateSettings(DEFAULT_SETTINGS)).toEqual({ ok: true, value: DEFAULT_SETTINGS }));
  it('accepts caps of null and numbers', () => expect(validateSettings({ ...DEFAULT_SETTINGS, maxPointsVisit: 40, maxPoints24h: 120 }).ok).toBe(true));
  it.each([
    ['pointsPerBlock', 0], ['pointsPerBlock', 1001], ['pointsPerBlock', 1.5], ['blockMinutes', 0], ['blockMinutes', 1441],
    ['minMinutes', -1], ['maxPointsVisit', 0], ['maxPoints24h', 100001], ['maxStayHours', 0], ['maxStayHours', 73],
    ['cooldownSeconds', -1], ['cooldownSeconds', 601], ['rounding', 'sideways'], ['pointsPerBlock', '8'], ['pointsPerBlock', null],
  ])('rejects %s = %j and names the field', (field, value) => {
    const r = validateSettings({ ...DEFAULT_SETTINGS, [field]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });
  it('rejects a missing field and a non-object', () => {
    const { rounding, ...rest } = DEFAULT_SETTINGS; void rounding;
    expect(validateSettings(rest).ok).toBe(false);
    expect(validateSettings('x').ok).toBe(false);
    expect(validateSettings(null).ok).toBe(false);
  });
});

describe('stored settings', () => {
  it('start as the defaults', () => expect(getSettings(openDb(':memory:'))).toEqual(DEFAULT_SETTINGS));
  it('round trip, including empty caps', () => {
    const db = openDb(':memory:');
    const next = s({ pointsPerBlock: 5, blockMinutes: 10, rounding: 'prorata', maxPointsVisit: 40, maxPoints24h: null, cooldownSeconds: 0 });
    saveSettings(db, next);
    expect(getSettings(db)).toEqual(next);
    saveSettings(db, s());
    expect(getSettings(db)).toEqual(s());
  });
});
