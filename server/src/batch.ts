export const MAX_BATCH = 100;                       // terminals in one go
export const MAX_EXPIRY_MINUTES = 7 * 24 * 60;      // a pairing code lives at most a week
const MAX_TEXT = 20_000;
const MAX_FIELD = 60;

export interface BatchRow { place: string; name: string }

/**
 * Reads the group-pairing list: one terminal per line, the place first and then the terminal's name, like
 *   Floorball Terminal 1
 * The place is the first word. To use a place of several words, separate it from the name with a tab (as pasted
 * from a spreadsheet) or a "|": "Main hall | Bar 2". Blank lines are skipped.
 */
export function parseTerminalLines(text: unknown): { ok: true; rows: BatchRow[] } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: 'Paste the list of terminals, one per line' };
  if (text.length > MAX_TEXT) return { ok: false, error: 'The list is too long' };
  const rows: BatchRow[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = `Line ${i + 1}`;
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line)) return { ok: false, error: `${at} has a character that can't be used` };
    let place: string, name: string;
    const tab = line.indexOf('\t'), bar = line.indexOf('|');
    if (tab >= 0) { place = line.slice(0, tab); name = line.slice(tab + 1); }
    else if (bar >= 0) { place = line.slice(0, bar); name = line.slice(bar + 1); }
    else { const m = /^(\S+)\s+(.*)$/.exec(line); place = m ? m[1] : line; name = m ? m[2] : ''; }
    place = place.trim(); name = name.trim().replace(/\t+/g, ' ');
    if (!place || !name) return { ok: false, error: `${at}: write the place and then the terminal name, like “Floorball Terminal 1”` };
    if (place.length > MAX_FIELD || name.length > MAX_FIELD) return { ok: false, error: `${at}: the place and the name can each be up to ${MAX_FIELD} characters` };
    const key = `${place.toLowerCase()}\u0000${name.toLowerCase()}`;
    if (seen.has(key)) return { ok: false, error: `${at}: “${place} ${name}” is in the list twice` };
    seen.add(key);
    rows.push({ place, name });
    if (rows.length > MAX_BATCH) return { ok: false, error: `Up to ${MAX_BATCH} terminals at a time` };
  }
  if (!rows.length) return { ok: false, error: 'The list is empty' };
  return { ok: true, rows };
}
