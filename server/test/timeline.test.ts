import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.TZ = 'UTC';   // days and hours are the viewer's; fix it so the expected numbers are the same everywhere

type Result = { html: string; width: number; days: number; hiddenDays: number; lanes: string[] };
const win: { PontTimeline?: { render: (report: unknown, opts?: object) => Result } } = {};
new Function('window', readFileSync(new URL('../public/admin/timeline.js', import.meta.url), 'utf8'))(win);
const { render } = win.PontTimeline!;

const at = (day: string, hm: string) => `${day}T${hm}:00.000Z`;
const visit = (id: number, zone: string, inAt: string, outAt: string | null, status: string, minutes: number | null, points = 0) =>
  ({ id, zone, status, inAt, inPlace: 'Main door', outAt, outPlace: outAt ? 'Main door' : '', minutes, points, raw: points, cappedBy: null });
const ev = (type: string, when: string, points: number, extra: object = {}) => ({ at: when, type, place: 'Bar 2', zone: '', points, minutes: null, note: null, by: 'Bar 2', visitId: null, txId: 1, stornoed: false, ...extra });
const NOW = Date.parse('2026-11-01T18:00:00Z');
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe('the timeline', () => {
  it('says so when there is nothing to draw', () => {
    const r = render({ visits: [], events: [] });
    expect(r.html).toContain('Nothing has happened');
    expect(r).toMatchObject({ days: 0, width: 0, lanes: [] });
  });

  it('draws a visit as a bar in its zone’s lane, labelled with the points and the time', () => {
    const report = { visits: [visit(1, 'Main area', at('2026-10-31', '14:00'), at('2026-10-31', '14:40'), 'closed', 40, 24)], events: [] };
    const r = render(report, { pxPerHour: 200, nowMs: NOW });                   // 40 minutes is 133 px: room for the long label
    expect(r.lanes).toEqual(['Main area']);
    expect(r.days).toBe(1);
    expect(count(r.html, /class="tl-visit closed"/g)).toBe(1);
    expect(r.html).toContain('+24 · 40 min');
    expect(r.html).toContain('Main area: paid');
    expect(r.html).toContain('Sat 31 Oct');
    expect(render(report, { pxPerHour: 120, nowMs: NOW }).html).toContain('>+24</text>');   // 80 px: just the points
    expect(render(report, { pxPerHour: 30, nowMs: NOW }).html).not.toContain('tl-bartext');   // 20 px: too narrow for any label
  });

  it('a bar is as wide as the time it covers: twice the zoom, twice the width', () => {
    const report = { visits: [visit(1, 'Main area', at('2026-10-31', '14:00'), at('2026-10-31', '16:00'), 'closed', 120, 80)], events: [] };
    const bar = (px: number) => Number(/class="tl-bar" x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(render(report, { pxPerHour: px, nowMs: NOW }).html)![1]);
    expect(bar(100)).toBeCloseTo(200); expect(bar(50)).toBeCloseTo(100);
  });

  it('only days with something on them are drawn, a quiet gap is marked, and busy days sit next to each other', () => {
    const report = { visits: [
      visit(1, 'Main area', at('2026-10-20', '09:00'), at('2026-10-20', '10:00'), 'closed', 60, 40),
      visit(2, 'Main area', at('2026-10-21', '09:00'), at('2026-10-21', '10:00'), 'closed', 60, 40),
      visit(3, 'Main area', at('2026-10-30', '09:00'), at('2026-10-30', '10:00'), 'closed', 60, 40)], events: [] };
    const r = render(report, { nowMs: NOW });
    expect(r.days).toBe(3);                                                // not 11
    expect(count(r.html, /class="tl-break"/g)).toBe(1);                    // one gap between the 21st and the 30th
    expect(r.html).toContain('Tue 20 Oct'); expect(r.html).toContain('Fri 30 Oct'); expect(r.html).not.toContain('Sun 25 Oct');
  });

  it('can show only the last few days with activity, and says how many it left out', () => {
    const report = { visits: ['20', '21', '22', '23'].map((d, i) => visit(i + 1, 'Main area', at(`2026-10-${d}`, '09:00'), at(`2026-10-${d}`, '10:00'), 'closed', 60, 40)), events: [] };
    expect(render(report, { nowMs: NOW }).days).toBe(4);
    const r = render(report, { lastDays: 2, nowMs: NOW });
    expect(r).toMatchObject({ days: 2, hiddenDays: 2 });
    expect(r.html).not.toContain('Tue 20 Oct'); expect(r.html).toContain('Fri 23 Oct');
  });

  it('a visit across midnight is drawn in both days, joined by arrows, labelled once', () => {
    const r = render({ visits: [visit(1, 'Main area', at('2026-10-31', '22:00'), at('2026-11-01', '02:00'), 'closed', 240, 160)], events: [] }, { pxPerHour: 120, nowMs: NOW });
    expect(r.days).toBe(2);
    expect(count(r.html, /class="tl-bar"/g)).toBe(2);
    expect(count(r.html, /class="tl-more"/g)).toBe(2);                     // one arrow leaving the first day, one entering the second
    expect(count(r.html, /class="tl-bartext"/g)).toBe(1);
    expect(count(r.html, /class="tl-break"/g)).toBe(0);                    // consecutive days: no gap marker
    expect(count(r.html, />00<\/text>/g)).toBe(1);                           // midnight is labelled once, at the start of the second day, not twice
  });

  it('gives each zone its own lane, and colours a visit by what became of it', () => {
    const report = { visits: [
      visit(1, 'Main area', at('2026-10-31', '10:00'), at('2026-10-31', '11:00'), 'closed', 60, 40),
      visit(2, 'Gym', at('2026-10-31', '12:00'), at('2026-10-31', '12:30'), 'discarded', 30),
      visit(3, 'Gym', at('2026-10-31', '13:00'), at('2026-10-31', '23:00'), 'expired', 600),
      visit(4, 'Main area', at('2026-11-01', '17:00'), null, 'open', null)], events: [] };
    const r = render(report, { nowMs: NOW });
    expect(r.lanes).toEqual(['Main area', 'Gym']);
    for (const status of ['closed', 'discarded', 'expired', 'open']) expect(r.html).toContain(`class="tl-visit ${status}"`);
    expect(r.html).toContain('inside now');
    expect(r.html).toContain('class="tl-now"');                            // the line at the present, since a visit is open
  });

  it('draws grants, refunds and adjustments as dots with signed labels, spread over rows when close together', () => {
    const t = (hm: string) => at('2026-10-31', hm);
    const r = render({ visits: [], events: [
      ev('grant', t('10:00'), 8), ev('grant', t('10:01'), 10), ev('grant', t('10:02'), 12), ev('grant', t('10:03'), 14),
      ev('refund', t('11:00'), -8), ev('adjust', t('12:00'), 5, { note: 'Prize', by: 'Admin', place: 'Admin' }),
      ev('checkin', t('13:00'), 0)], }, { pxPerHour: 60, nowMs: NOW });
    expect(count(r.html, /class="tl-mark /g)).toBe(6);                    // the check-in is a bar, never a dot
    expect(r.html).toContain('class="tl-mark pos"'); expect(r.html).toContain('class="tl-mark neg"'); expect(r.html).toContain('class="tl-mark adjust"');
    expect(r.html).toContain('+8'); expect(r.html).toContain('−8'); expect(r.html).toContain('+5');
    const ys = [...r.html.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle">\+(?:8|10|12|14)</g)].map(m => Number(m[1]));
    expect(new Set(ys).size).toBeGreaterThan(1);                           // four labels within four minutes: not all on one line
    expect(r.html).toContain('Prize');
    expect(r.lanes).toEqual([]);                                           // a card with only grants has just the Points lane
  });

  it('a reversed grant is marked as undone', () => {
    const r = render({ visits: [], events: [ev('grant', at('2026-10-31', '10:00'), 8, { stornoed: true })] }, { nowMs: NOW });
    expect(r.html).toContain('tl-mark pos undone');
    expect(r.html).toContain('Reversed later');
  });

  it('never lets what is written in a name or note into the page as markup', () => {
    const evil = '<img src=x onerror=alert(1)>"&';
    const r = render({ visits: [{ ...visit(1, evil, at('2026-10-31', '10:00'), at('2026-10-31', '11:00'), 'closed', 60, 5), inPlace: evil, outPlace: evil }],
      events: [ev('adjust', at('2026-10-31', '10:30'), 3, { note: evil, by: evil, place: evil })] }, { nowMs: NOW });
    expect(r.html).not.toContain('<img');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('copes with a zero-length visit, bad dates and a visit whose end is before its start', () => {
    const r = render({ visits: [
      visit(1, 'Main area', at('2026-10-31', '10:00'), at('2026-10-31', '10:00'), 'closed', 0, 0),
      { ...visit(2, 'Main area', 'nonsense', null, 'closed', 5, 1) },
      visit(3, 'Main area', at('2026-10-31', '12:00'), at('2026-10-31', '11:00'), 'closed', 0, 0)], events: [ev('grant', 'also nonsense', 3)] }, { nowMs: NOW });
    expect(r.days).toBe(1);
    expect(count(r.html, /class="tl-bar"/g)).toBe(2);
    expect(r.html).not.toContain('NaN');
  });

  it('produces an SVG whose size matches its content and a label column that lines up with the lanes', () => {
    const r = render({ visits: [visit(1, 'Main area', at('2026-10-31', '10:00'), at('2026-10-31', '11:00'), 'closed', 60, 40), visit(2, 'Gym', at('2026-10-31', '12:00'), at('2026-10-31', '13:00'), 'closed', 60, 20)], events: [ev('grant', at('2026-10-31', '12:30'), 3)] }, { nowMs: NOW });
    const m = /<svg[^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(r.html)!;
    expect([m[1], m[2]]).toEqual([m[3], m[4]]);
    expect(Number(m[1])).toBe(r.width);
    const tops = [...r.html.matchAll(/class="tl-lane[^"]*" style="top:(\d+)px/g)].map(x => Number(x[1]));
    expect(tops).toHaveLength(3);                                          // two zones and Points
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  });
});
