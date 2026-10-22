/** Canonical form: uppercase hex bytes joined by colons. Accepts 4, 7 or 10 byte UIDs. */
export function normalizeUid(input: string): string | null {
  const hex = String(input ?? '').replace(/[\s:\-]/g, '');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = hex.length / 2;
  if (![4, 7, 10].includes(bytes)) return null;
  return hex.toUpperCase().match(/../g)!.join(':');
}
