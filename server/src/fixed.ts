/** Rules of a reader in fixed-amount mode: every tap gives [amount] points, within these limits per card. Null = no limit. */
export interface FixedSettings {
  amount: number;
  cooldownSeconds: number;
  maxUses24h: number | null;
  maxPoints24h: number | null;
  maxUsesTotal: number | null;
}

/** What one card has already done at one reader. Stornoed grants are not counted. */
export interface FixedStats {
  lastAtMs: number | null;
  uses24h: number;
  points24h: number;
  usesTotal: number;
  oldestInWindowMs: number | null;
}

export type FixedVerdict =
  | { ok: true }
  | { ok: false; action: 'cooldown' | 'limit_uses' | 'limit_points' | 'limit_total'; retryInSeconds: number | null };

export const DEFAULT_FIXED: FixedSettings = { amount: 10, cooldownSeconds: 60, maxUses24h: null, maxPoints24h: null, maxUsesTotal: null };

const DAY_MS = 24 * 3600 * 1000;

export function validateFixed(input: unknown): { ok: true; value: FixedSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Fixed-amount settings must be an object' };
  const o = input as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(o.amount, 1, 9999)) return { ok: false, error: 'amount must be a whole number from 1 to 9999' };
  if (!int(o.cooldownSeconds, 0, 86400)) return { ok: false, error: 'cooldownSeconds must be a whole number from 0 to 86400' };
  for (const [field, hi] of [['maxUses24h', 1000], ['maxPoints24h', 100000], ['maxUsesTotal', 100000]] as const) {
    if (o[field] !== null && !int(o[field], 1, hi)) return { ok: false, error: `${field} must be empty or a whole number from 1 to ${hi}` };
  }
  if (o.maxPoints24h !== null && (o.maxPoints24h as number) < (o.amount as number)) {
    return { ok: false, error: 'maxPoints24h must be at least the amount of one tap, or nobody could ever get points' };
  }
  return { ok: true, value: {
    amount: o.amount as number, cooldownSeconds: o.cooldownSeconds as number, maxUses24h: o.maxUses24h as number | null,
    maxPoints24h: o.maxPoints24h as number | null, maxUsesTotal: o.maxUsesTotal as number | null,
  } };
}

/**
 * Whether a card may get points now. Checked in this order, so a person who hit a daily limit hears "limit"
 * rather than "wait a bit": lifetime taps, taps in 24 h, points in 24 h, seconds since the last tap.
 */
export function evaluateFixed(s: FixedSettings, st: FixedStats, nowMs: number): FixedVerdict {
  const untilWindowFrees = st.oldestInWindowMs === null ? null : Math.max(1, Math.ceil((st.oldestInWindowMs + DAY_MS - nowMs) / 1000));
  if (s.maxUsesTotal !== null && st.usesTotal >= s.maxUsesTotal) return { ok: false, action: 'limit_total', retryInSeconds: null };
  if (s.maxUses24h !== null && st.uses24h >= s.maxUses24h) return { ok: false, action: 'limit_uses', retryInSeconds: untilWindowFrees };
  if (s.maxPoints24h !== null && st.points24h + s.amount > s.maxPoints24h) return { ok: false, action: 'limit_points', retryInSeconds: untilWindowFrees };
  if (st.lastAtMs !== null && s.cooldownSeconds > 0) {
    const waitMs = s.cooldownSeconds * 1000 - (nowMs - st.lastAtMs);
    if (waitMs > 0) return { ok: false, action: 'cooldown', retryInSeconds: Math.ceil(waitMs / 1000) };
  }
  return { ok: true };
}
