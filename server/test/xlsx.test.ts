import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

// The admin page loads xlsx.js as a plain script that sets window.PontXlsx; load it the same way here.
function load() {
  const win: { PontXlsx?: { build: (name: string, rows: string[][], widths?: number[]) => Uint8Array } } = {};
  new Function('window', readFileSync(new URL('../public/admin/xlsx.js', import.meta.url), 'utf8'))(win);
  return win.PontXlsx!;
}

/** Reads a zip the way Excel does: through the central directory at the end. Checks each entry's CRC and size. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOffset = dv.getUint32(eocd + 16, true);
  expect(cdOffset + cdSize).toBe(eocd);
  const out: Record<string, string> = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(method).toBe(0);
    expect(size).toBe(usize);
    expect(dv.getUint32(local, true)).toBe(0x04034b50);
    const lNameLen = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    expect(lNameLen).toBe(nameLen);
    const data = bytes.subarray(local + 30 + lNameLen + lExtra, local + 30 + lNameLen + lExtra + size);
    expect(crc32(data)).toBe(crc);
    out[name] = new TextDecoder().decode(data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('xlsx writer', () => {
  const rows = [['Place', 'Terminal', 'Pairing code'], ['Floorball', 'Terminal 1', '012345'], ['Checkin', "Anna's <Terminal> & \"co\"", '999999'], ['Árvíztűrő', 'Tükörfúrógép 😀', '000001']];

  it('is a valid zip with the parts a spreadsheet needs, every checksum right', () => {
    const files = unzip(load().build('Pairing codes', rows, [14, 26, 14]));
    expect(Object.keys(files).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    for (const text of Object.values(files)) expect(text.startsWith('<?xml')).toBe(true);
    expect(files['xl/workbook.xml']).toContain('name="Pairing codes"');
  });

  it('keeps every value as text, so a code keeps its leading zero, and escapes XML characters', () => {
    const sheet = unzip(load().build('S', rows))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">012345</t></is></c>');
    expect(sheet).toContain("Anna's &lt;Terminal&gt; &amp; &quot;co&quot;");
    expect(sheet).toContain('Árvíztűrő');
    expect(sheet).toContain('😀');
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');          // header row is bold
    expect(sheet).not.toContain('<c r="A2" t="inlineStr" s="1">');
    expect(sheet).toContain('<pane ySplit="1"');                         // header stays in view
  });

  it('a value that looks like a formula stays plain text', () => {
    const sheet = unzip(load().build('S', [['A'], ['=HYPERLINK("http://evil","x")'], ['+1'], ['@SUM(1)']]))['xl/worksheets/sheet1.xml'];
    expect(sheet).not.toMatch(/<f>/);
    expect(sheet.match(/t="inlineStr"/g)).toHaveLength(4);
  });

  it('drops characters XML cannot hold and cleans the sheet name', () => {
    const files = unzip(load().build('Bad/name:[1]?*' + 'x'.repeat(40), [['a\u0000b\u0001c']]));
    expect(files['xl/worksheets/sheet1.xml']).toContain('>abc<');
    const name = /name="([^"]*)"/.exec(files['xl/workbook.xml'])![1];
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[\[\]:*?\/\\]/);
  });

  it('handles an empty list of rows and a large table', () => {
    expect(() => unzip(load().build('S', []))).not.toThrow();
    const big = Array.from({ length: 500 }, (_, i) => ['P', `T${i}`, String(i).padStart(6, '0')]);
    const sheet = unzip(load().build('S', big))['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('<row r="500">');
  });
});
