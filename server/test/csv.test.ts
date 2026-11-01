import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

type Row = { line: number; name: string; uid: string; points: number | string | undefined; photo: string };
type Parsed = { ok: true; rows: Row[]; header: boolean; delimiter: string } | { ok: false; error: string };
type Match = { index?: number; none?: true; error?: string };

// The admin page loads csv.js as a plain script that sets window.PontCsv; load it the same way here.
const win: { PontCsv?: { parse: (t: string) => Parsed; matchPhoto: (p: string, files: string[]) => Match; baseName: (s: string) => string } } = {};
new Function('window', readFileSync(new URL('../public/admin/csv.js', import.meta.url), 'utf8'))(win);
const { parse, matchPhoto } = win.PontCsv!;

const rows = (t: string) => { const r = parse(t); if (!r.ok) throw new Error(r.error); return r.rows; };
const err = (t: string) => { const r = parse(t); if (r.ok) throw new Error('expected an error'); return r.error; };

describe('reading the pasted list', () => {
  it('reads a list with a header row', () => {
    const r = parse('name,uid,points,photo\nAnna Kovács,04A23B1C,12,anna.jpg\nBéla Nagy,04BBCCDD,0,bela.png');
    expect(r).toMatchObject({ ok: true, header: true, delimiter: ',' });
    expect((r as { rows: Row[] }).rows).toEqual([
      { line: 2, name: 'Anna Kovács', uid: '04A23B1C', points: 12, photo: 'anna.jpg' },
      { line: 3, name: 'Béla Nagy', uid: '04BBCCDD', points: 0, photo: 'bela.png' },
    ]);
  });

  it('finds the columns by name, in any order, and ignores columns it does not know', () => {
    expect(rows('Photo,Extra,UID,Name\nx.jpg,zzz,04A23B1C,Anna')).toEqual([{ line: 2, name: 'Anna', uid: '04A23B1C', points: undefined, photo: 'x.jpg' }]);
  });

  it('understands the usual and the Hungarian column names', () => {
    expect(rows('Név;Kártya;Pontok;Kép\nAnna;04A23B1C;7;a.jpg')[0]).toMatchObject({ name: 'Anna', uid: '04A23B1C', points: 7, photo: 'a.jpg' });
    expect(rows('Holder Name\tCard UID\tStarting Points\tPFP File Name\nAnna\t04A23B1C\t7\ta.jpg')[0]).toMatchObject({ name: 'Anna', uid: '04A23B1C', points: 7, photo: 'a.jpg' });
    expect(rows('full_name,rfid,balance,avatar\nAnna,04A23B1C,7,a.jpg')[0]).toMatchObject({ name: 'Anna', uid: '04A23B1C', points: 7, photo: 'a.jpg' });
  });

  it('without a header, takes name, uid, points, photo in that order, and points and photo may be missing', () => {
    expect(parse('Anna Kovács,04A23B1C,12,anna.jpg')).toMatchObject({ ok: true, header: false });
    expect(rows('Anna Kovács,04A23B1C,12,anna.jpg')[0]).toEqual({ line: 1, name: 'Anna Kovács', uid: '04A23B1C', points: 12, photo: 'anna.jpg' });
    expect(rows('Anna,04A23B1C')[0]).toEqual({ line: 1, name: 'Anna', uid: '04A23B1C', points: undefined, photo: '' });
    expect(rows('Anna,04A23B1C,5')[0]).toMatchObject({ points: 5, photo: '' });
  });

  it('a first row of data is not mistaken for a header', () => {
    expect(parse('Card,04:A2:3B:1C')).toMatchObject({ ok: true, header: false });   // a person called "Card" with a UID
  });

  it('picks the separator itself: comma, semicolon or tab (as pasted from a spreadsheet)', () => {
    for (const [sep, name] of [[',', 'comma'], [';', 'semicolon'], ['\t', 'tab']] as const) {
      const r = parse(['name', 'uid', 'points', 'photo'].join(sep) + `\nAnna${sep}04A23B1C${sep}3${sep}a.jpg`);
      expect(r, name).toMatchObject({ ok: true, delimiter: sep });
      expect((r as { rows: Row[] }).rows[0], name).toMatchObject({ name: 'Anna', uid: '04A23B1C', points: 3, photo: 'a.jpg' });
    }
  });

  it('a quoted name may hold the separator, a quote and a line break; line numbers still count real lines', () => {
    const r = rows('name,uid\n"Kovács, Anna",04A23B1C\n"Tom ""T"" Smith",04A23B1D\n"Two\nlines",04A23B1E\nLast,04A23B1F');
    expect(r.map(x => x.name)).toEqual(['Kovács, Anna', 'Tom "T" Smith', 'Two\nlines', 'Last']);
    expect(r.map(x => x.line)).toEqual([2, 3, 4, 6]);
  });

  it('copes with a byte-order mark, Windows line endings, blank lines, spaces and trailing separators', () => {
    const r = rows('\uFEFFname,uid,points\r\n\r\n  Anna  ,  04A23B1C ,  5 ,\r\n\r\n,,\r\nBéla,04BBCCDD,\r\n');
    expect(r).toEqual([
      { line: 3, name: 'Anna', uid: '04A23B1C', points: 5, photo: '' },
      { line: 6, name: 'Béla', uid: '04BBCCDD', points: undefined, photo: '' },
    ]);
  });

  it('turns whole-number points into numbers and passes anything else on as text for the server to refuse', () => {
    const r = rows('name,uid,points\nA,04A23B1C,0012\nB,04A23B1D,-3\nC,04A23B1E,1.5\nD,04A23B1F,lots\nE,04A23B20,');
    expect(r.map(x => x.points)).toEqual([12, '-3', '1.5', 'lots', undefined]);
  });

  it('keeps only the file name from a path in the photo column', () => {
    const r = rows('name,uid,photo\nA,04A23B1C,photos/anna.jpg\nB,04A23B1D,C:\\pics\\bela.png\nC,04A23B1E,"  carl.jpeg "');
    expect(r.map(x => x.photo)).toEqual(['anna.jpg', 'bela.png', 'carl.jpeg']);
  });

  it('says what is missing', () => {
    expect(err('')).toMatch(/Paste the list/);
    expect(err('  \n \n')).toMatch(/Paste the list/);
    expect(err('uid,points\n04A23B1C,5')).toMatch(/no “name” column/);
    expect(err('name,points\nAnna,5')).toMatch(/no “uid” column/);
    expect(err('name,uid')).toMatch(/no cards/);
  });

  it('an empty cell stays a row, so the server can say which card has no name or UID', () => {
    const r = rows('name,uid\n,04A23B1C\nAnna,');
    expect(r).toEqual([{ line: 2, name: '', uid: '04A23B1C', points: undefined, photo: '' }, { line: 3, name: 'Anna', uid: '', points: undefined, photo: '' }]);
  });

  it('handles a long list quickly', () => {
    const text = 'name,uid,points,photo\n' + Array.from({ length: 1000 }, (_, i) => `Person ${i},${i.toString(16).padStart(8, '0')},${i},p${i}.jpg`).join('\n');
    const t0 = Date.now();
    expect(rows(text)).toHaveLength(1000);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('matching photo names to the chosen files', () => {
  const files = ['Anna.JPG', 'bela.png', 'carl.jpeg', 'dora.jpg', 'dora.png', 'dup.jpg', 'sub/dup.jpg'];
  it('matches the exact file name, ignoring capitals and folders', () => {
    expect(matchPhoto('anna.jpg', files)).toEqual({ index: 0 });
    expect(matchPhoto('BELA.PNG', files)).toEqual({ index: 1 });
    expect(matchPhoto('photos/carl.jpeg', files)).toEqual({ index: 2 });
  });
  it('a name without an extension finds the one file that starts with it', () => {
    expect(matchPhoto('anna', files)).toEqual({ index: 0 });
    expect(matchPhoto('carl', files)).toEqual({ index: 2 });
  });
  it('refuses to guess between several', () => {
    expect(matchPhoto('dora', files).error).toMatch(/Several chosen files start with dora/);
    expect(matchPhoto('dup.jpg', files).error).toMatch(/Several chosen files are called dup.jpg/);
  });
  it('says when no file matches, and has nothing to say when the row names no photo', () => {
    expect(matchPhoto('eve.jpg', files).error).toMatch(/No chosen file is called eve.jpg/);
    expect(matchPhoto('anna.png', files).error).toMatch(/No chosen file/);   // an extension is not guessed
    expect(matchPhoto('', files)).toEqual({ none: true });
    expect(matchPhoto('   ', files)).toEqual({ none: true });
  });
});
