import { describe, it, expect } from 'vitest';
import { normalizeUid } from '../src/uid.js';

describe('normalizeUid', () => {
  it('uppercases and colon-separates plain hex', () => expect(normalizeUid('04a23b1c')).toBe('04:A2:3B:1C'));
  it('accepts dashes, spaces and colons', () => {
    expect(normalizeUid('04-a2-3b-1c')).toBe('04:A2:3B:1C');
    expect(normalizeUid('04 A2 3B 1C')).toBe('04:A2:3B:1C');
    expect(normalizeUid('04:a2:3b:1c')).toBe('04:A2:3B:1C');
  });
  it('accepts 7 and 10 byte UIDs', () => {
    expect(normalizeUid('04A23B1C5D6E7F')).toBe('04:A2:3B:1C:5D:6E:7F');
    expect(normalizeUid('04A23B1C5D6E7F8091A2')).toHaveLength(29);
  });
  it('rejects non-hex, empty and wrong lengths', () => {
    expect(normalizeUid('zz')).toBeNull();
    expect(normalizeUid('')).toBeNull();
    expect(normalizeUid('04A23B1C5D')).toBeNull();
    expect(normalizeUid('04A23B')).toBeNull();
  });
});
