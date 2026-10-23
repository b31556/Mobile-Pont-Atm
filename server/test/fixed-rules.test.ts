import { describe, it, expect } from 'vitest';
import { DEFAULT_FIXED, evaluateFixed, validateFixed, type FixedSettings, type FixedStats } from '../src/fixed.js';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const s = (over: Partial<FixedSettings> = {}): FixedSettings => ({ ...DEFAULT_FIXED, cooldownSeconds: 0, ...over });
const stats = (over: Partial<FixedStats> = {}): FixedStats => ({ lastAtMs: null, uses24h: 0, points24h: 0, usesTotal: 0, oldestInWindowMs: null, ...over });

describe('defaults and validation', () => {
  it('a new reader gives 10 points, at most once a minute per card, with no other limit', () => {
    expect(DEFAULT_FIXED).toEqual({ amount: 10, cooldownSeconds: 60, maxUses24h: null, maxPoints24h: null, maxUsesTotal: null });
  });
  it('accepts the defaults and sensible limits', () => {
    expect(validateFixed(DEFAULT_FIXED).ok).toBe(true);
    expect(validateFixed({ amount: 5, cooldownSeconds: 0, maxUses24h: 3, maxPoints24h: 15, maxUsesTotal: 100 }).ok).toBe(true);
  });
  it.each([
    ['amount', 0], ['amount', 10000], ['amount', 1.5], ['amount', '10'], ['amount', null],
    ['cooldownSeconds', -1], ['cooldownSeconds', 86401], ['cooldownSeconds', null],
    ['maxUses24h', 0], ['maxUses24h', 1001], ['maxPoints24h', 0], ['maxPoints24h', 100001], ['maxUsesTotal', 0], ['maxUsesTotal', 100001],
  ])('rejects %s = %j and names the field', (field, value) => {
    const r = validateFixed({ ...DEFAULT_FIXED, [field]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(field);
  });
  it('a daily points limit lower than one grant could never be met, so it is refused', () => {
    const r = validateFixed({ ...DEFAULT_FIXED, amount: 10, maxPoints24h: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('maxPoints24h');
  });
  it('rejects a missing field and a non-object', () => {
    const { amount, ...rest } = DEFAULT_FIXED; void amount;
    expect(validateFixed(rest).ok).toBe(false);
    expect(validateFixed(null).ok).toBe(false);
    expect(validateFixed('x').ok).toBe(false);
  });
});

describe('evaluateFixed', () => {
  it('allows a first tap', () => expect(evaluateFixed(s(), stats(), NOW)).toEqual({ ok: true }));

  it('refuses a tap inside the seconds-between-taps window and says how long to wait', () => {
    const r = evaluateFixed(s({ cooldownSeconds: 60 }), stats({ lastAtMs: NOW - 20_000 }), NOW);
    expect(r).toEqual({ ok: false, action: 'cooldown', retryInSeconds: 40 });
  });
  it('allows a tap exactly when the window ends', () => {
    expect(evaluateFixed(s({ cooldownSeconds: 60 }), stats({ lastAtMs: NOW - 60_000 }), NOW)).toEqual({ ok: true });
  });
  it('a zero window means no waiting', () => {
    expect(evaluateFixed(s({ cooldownSeconds: 0 }), stats({ lastAtMs: NOW }), NOW)).toEqual({ ok: true });
  });

  it('refuses when the taps in the last 24 hours reached the limit, and says when the oldest one expires', () => {
    const r = evaluateFixed(s({ maxUses24h: 3 }), stats({ uses24h: 3, oldestInWindowMs: NOW - 20 * HOUR }), NOW);
    expect(r).toEqual({ ok: false, action: 'limit_uses', retryInSeconds: 4 * 3600 });
  });
  it('one tap under the limit is still allowed', () => {
    expect(evaluateFixed(s({ maxUses24h: 3 }), stats({ uses24h: 2, oldestInWindowMs: NOW - HOUR }), NOW)).toEqual({ ok: true });
  });

  it('refuses when one more grant would pass the points limit', () => {
    const r = evaluateFixed(s({ amount: 10, maxPoints24h: 25 }), stats({ points24h: 20, uses24h: 2, oldestInWindowMs: NOW - 23 * HOUR }), NOW);
    expect(r).toEqual({ ok: false, action: 'limit_points', retryInSeconds: 3600 });
  });
  it('a grant that lands exactly on the points limit is allowed', () => {
    expect(evaluateFixed(s({ amount: 10, maxPoints24h: 30 }), stats({ points24h: 20, uses24h: 2, oldestInWindowMs: NOW - HOUR }), NOW)).toEqual({ ok: true });
  });

  it('refuses for good once the lifetime limit is reached', () => {
    expect(evaluateFixed(s({ maxUsesTotal: 5 }), stats({ usesTotal: 5 }), NOW)).toEqual({ ok: false, action: 'limit_total', retryInSeconds: null });
  });

  it('checks the lifetime limit first, then the daily ones, then the wait', () => {
    const all = s({ cooldownSeconds: 60, maxUses24h: 1, maxPoints24h: 10, maxUsesTotal: 1 });
    const st = stats({ lastAtMs: NOW - 1000, uses24h: 1, points24h: 10, usesTotal: 1, oldestInWindowMs: NOW - HOUR });
    expect((evaluateFixed(all, st, NOW) as { action: string }).action).toBe('limit_total');
    expect((evaluateFixed({ ...all, maxUsesTotal: null }, st, NOW) as { action: string }).action).toBe('limit_uses');
    expect((evaluateFixed({ ...all, maxUsesTotal: null, maxUses24h: null }, st, NOW) as { action: string }).action).toBe('limit_points');
    expect((evaluateFixed({ ...all, maxUsesTotal: null, maxUses24h: null, maxPoints24h: null }, st, NOW) as { action: string }).action).toBe('cooldown');
  });

  it('never reports a wait of less than one second', () => {
    const r = evaluateFixed(s({ maxUses24h: 1 }), stats({ uses24h: 1, oldestInWindowMs: NOW - 24 * HOUR + 200 }), NOW);
    expect(r).toEqual({ ok: false, action: 'limit_uses', retryInSeconds: 1 });
  });
});
