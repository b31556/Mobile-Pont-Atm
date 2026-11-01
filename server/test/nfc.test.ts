import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

type Nfc = { normalizeUid: (s: unknown) => string | null; findByUid: (cards: { uid: string }[], uid: string) => unknown };
const win: { PontNfc?: Nfc } = {};
new Function('window', readFileSync(new URL('../public/admin/nfc.js', import.meta.url), 'utf8'))(win);
const N = win.PontNfc!;

describe('UIDs', () => {
  it('any spelling gives the server’s form', () => {
    for (const s of ['04:a2:3b:1c', '04A23B1C', '04-a2-3b-1c', ' 04 A2 3B 1C ']) expect(N.normalizeUid(s)).toBe('04:A2:3B:1C');
    expect(N.normalizeUid('04A23B1C556677')).toBe('04:A2:3B:1C:55:66:77');
  });
  it('refuses what is not a card id', () => {
    for (const s of ['', null, undefined, '04A23B', '04A23B1CZZ', '04A23B1C5', '04A23B1C55', 'hello', '0'.repeat(24)]) expect(N.normalizeUid(s as string)).toBeNull();
  });
  it('finds the card whatever its UID is spelled like', () => {
    const cards = [{ uid: '04:A2:3B:1C', name: 'Anna' }, { uid: '05:00:00:01', name: 'Ben' }];
    expect(N.findByUid(cards, '05000001')).toBe(cards[1]);
    expect(N.findByUid(cards, '04:A2:3B:1D')).toBeNull();
    expect(N.findByUid(cards, 'nonsense')).toBeNull();
    expect(N.findByUid([], '04:A2:3B:1C')).toBeNull();
  });
});
