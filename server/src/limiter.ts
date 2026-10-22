/** Counts failures per key inside a sliding window; a key at the limit is locked until its oldest failure ages out. */
export class AttemptLimiter {
  private fails = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.fails.get(key) ?? []).filter(t => t > cutoff);
    if (list.length) this.fails.set(key, list); else this.fails.delete(key);
    return list;
  }
  blocked(key: string): boolean { return this.recent(key).length >= this.max; }
  fail(key: string): void { this.fails.set(key, [...this.recent(key), this.now()]); }
  clear(key: string): void { this.fails.delete(key); }
}

export const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' };
