let last = 0;

/** The current time, but never the same millisecond twice, so records made in a burst keep their order. */
export function stamp(): Date {
  const t = Math.max(Date.now(), last + 1);
  last = t;
  return new Date(t);
}
