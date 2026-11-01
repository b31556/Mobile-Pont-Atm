import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateProgram } from '../src/program.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// The admin page loads program.js as a plain script that sets window.PontProgram; load it the same way here.
const win: { PontProgram?: any } = {};
new Function('window', readFileSync(new URL('../public/admin/program.js', import.meta.url), 'utf8'))(win);
const P = win.PontProgram;

const doc = () => ({
  title: 'Spring event',
  days: [{ key: 'day1', label: 'Day 1', date: '2026-04-10' }, { key: 'day2', label: 'Day 2', date: '2026-04-11' }],
  goal: { total: 60, dayKey: 'day2', dayMin: 30 },
  events: [
    { id: 'quiz', day: 'day2', title: 'Quiz', room: 'Quiz room', from: '09:00', to: '10:00', model: 'flat', cap: 12 },
    { id: 'table-tennis', day: 'day1', title: 'Table tennis', room: 'Hall', from: '10:00', to: '12:00', model: 'rate', rate: 8, block: 12, cap: 24 },
    { id: 'chess', day: 'day1', title: 'Chess', room: 'Library', from: '09:30', to: '11:00', model: 'tasks', items: [{ name: 'Puzzle', pts: 6, min: 20 }] },
  ],
});
const form = (extra: object = {}) => ({ ...P.blankForm(doc(), 'day1'), title: 'Darts', room: 'Hall', ...extra });

describe('the scoring summary', () => {
  it('says what a rate event pays', () => {
    expect(P.summary({ model: 'rate', rate: 8, block: 12 })).toBe('8 p / 12 min');
    expect(P.summary({ model: 'rate', rate: 8, block: 12, cap: 24 })).toBe('8 p / 12 min, up to 24 p');
    expect(P.summary({ model: 'rate', rate: 2, block: 5, cap: 10, maxMin: 60 })).toBe('2 p / 5 min, up to 10 p, counts at most 60 min');
  });
  it('counts the tasks and what they add up to', () => {
    expect(P.summary({ model: 'tasks', items: [{ name: 'A', pts: 6, min: 10 }, { name: 'B', pts: 6, min: 10 }, { name: 'C', pts: 6, min: 10 }] })).toBe('3 tasks, up to 18 p');
    expect(P.summary({ model: 'tasks', items: [{ name: 'A', pts: 5, min: 10 }] })).toBe('1 task, up to 5 p');
    expect(P.summary({ model: 'tasks', items: [{ name: 'A', pts: 5, min: 10 }], home: [{ name: 'H', pts: 2 }, { name: 'I', pts: 3 }] })).toBe('1 task, up to 5 p, 2 home tasks (+5 p)');
  });
  it('says what a flat award is for', () => {
    expect(P.summary({ model: 'flat', cap: 12 })).toBe('12 p for staying to the end');
  });
  it('writes the time range', () => { expect(P.timeRange({ from: '09:00', to: '10:30' })).toBe('09:00–10:30'); });
});

describe('order and groups', () => {
  it('sorts by day, then start time', () => {
    expect(P.sorted(doc()).map((e: any) => e.id)).toEqual(['chess', 'table-tennis', 'quiz']);
  });
  it('groups by day, keeps empty days, and puts events of an unknown day last', () => {
    const d = doc();
    d.events = d.events.filter(e => e.day === 'day1');
    d.events.push({ id: 'x', day: 'gone', title: 'Lost', room: 'R', from: '08:00', to: '09:00', model: 'flat', cap: 1 } as any);
    const g = P.groups(d);
    expect(g.map((x: any) => [x.day && x.day.key, x.events.map((e: any) => e.id)])).toEqual([['day1', ['chess', 'table-tennis']], ['day2', []], [null, ['x']]]);
  });
});

describe('ids made from titles', () => {
  it('makes a short readable id', () => {
    expect(P.slugId('Table tennis')).toBe('table-tennis');
    expect(P.slugId('  Quiz & Fun!! ')).toBe('quiz-fun');
    expect(P.slugId('Árvíztűrő tükörfúrógép')).toBe('arvizturo-tukorfurogep');
  });
  it('falls back to "event" when nothing usable is left', () => {
    expect(P.slugId('???')).toBe('event');
    expect(P.slugId('')).toBe('event');
  });
  it('is unique among the ids already used', () => {
    expect(P.slugId('Quiz', ['quiz'])).toBe('quiz-2');
    expect(P.slugId('Quiz', ['quiz', 'quiz-2'])).toBe('quiz-3');
  });
  it('is never longer than 40 characters, and always a valid id', () => {
    const long = 'a'.repeat(60);
    const first = P.slugId(long), second = P.slugId(long, [first]);
    expect(first).toHaveLength(40);
    expect(second).toHaveLength(40);
    expect(second.endsWith('-2')).toBe(true);
    for (const id of [first, second, P.slugId('x-'.repeat(30))]) expect(id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
});

describe('the event form', () => {
  it('turns the typed strings into numbers and keeps only what the model uses', () => {
    const e = P.eventFromForm(form({ model: 'rate', rate: '8', block: '12', cap: '24', maxMin: '', items: [{ name: 'Ignored', pts: '1', min: '1' }], rule: '  Play!  ' }));
    expect(e).toEqual({ day: 'day1', title: 'Darts', room: 'Hall', from: '10:00', to: '11:00', model: 'rate', rate: 8, block: 12, cap: 24, rule: 'Play!' });
  });
  it('drops task rows that were left empty', () => {
    const e = P.eventFromForm(form({ model: 'tasks', items: [{ name: 'Round 1', pts: '6', min: '20' }, { name: '', pts: '', min: '' }], home: [{ name: '', pts: '' }] }));
    expect(e.items).toEqual([{ name: 'Round 1', pts: 6, min: 20 }]);
    expect(e.home).toBeUndefined();
  });
  it('a flat event takes its points from cap', () => {
    expect(P.eventFromForm(form({ model: 'flat', cap: '12' })).cap).toBe(12);
  });
  it('turns an existing event into form values and back', () => {
    for (const e of doc().events) {
      const back = P.eventFromForm(P.formFromEvent(e));
      const { id, ...rest } = e as any;
      expect(back).toEqual(rest);
    }
    const f = P.formFromEvent({ ...doc().events[2], home: [{ name: 'Practice', pts: 2 }], kind: 'mix', note: 'Bring a pen' });
    expect(f).toMatchObject({ kind: 'mix', note: 'Bring a pen', home: [{ name: 'Practice', pts: '2' }] });
  });

  const problem = (extra: object) => P.validateEvent(P.eventFromForm(form(extra)), doc());
  it('accepts a good event of each model', () => {
    expect(problem({})).toBeNull();
    expect(problem({ model: 'tasks', items: [{ name: 'A', pts: '3', min: '10' }] })).toBeNull();
    expect(problem({ model: 'flat', cap: '5' })).toBeNull();
  });
  it('refuses the obvious mistakes in plain words', () => {
    expect(problem({ title: '  ' })).toMatch(/title/);
    expect(problem({ room: '' })).toMatch(/room/);
    expect(problem({ day: 'nope' })).toMatch(/day/);
    expect(problem({ from: '', to: '11:00' })).toMatch(/times/);
    expect(problem({ from: '12:00', to: '11:00' })).toMatch(/after it starts/);
    expect(problem({ from: '11:00', to: '11:00' })).toMatch(/after it starts/);
    expect(problem({ rate: '' })).toMatch(/Points per block/);
    expect(problem({ rate: '2.5' })).toMatch(/Points per block/);
    expect(problem({ rate: 'abc' })).toMatch(/Points per block/);
    expect(problem({ block: '0' })).toMatch(/block length/);
    expect(problem({ cap: '0' })).toMatch(/most points/);
    expect(problem({ maxMin: '-3' })).toMatch(/longest stay/);
    expect(problem({ model: 'flat', cap: '' })).toMatch(/staying to the end/);
    expect(problem({ model: 'tasks', items: [{ name: '', pts: '', min: '' }] })).toMatch(/1 to 20 tasks/);
    expect(problem({ model: 'tasks', items: [{ name: 'A', pts: '', min: '10' }] })).toMatch(/Task 1: points/);
    expect(problem({ model: 'tasks', items: [{ name: 'A', pts: '1', min: '0' }] })).toMatch(/Task 1: minutes/);
    expect(problem({ model: 'tasks', items: [{ name: 'A', pts: '1', min: '5' }], home: [{ name: 'H', pts: 'x' }] })).toMatch(/Home task 1/);
    expect(problem({ rule: 'x'.repeat(301) })).toMatch(/rule/);
  });
  it('whatever it accepts, the server accepts too', () => {
    for (const extra of [{}, { model: 'tasks', items: [{ name: 'A', pts: '3', min: '10' }], home: [{ name: 'H', pts: '1' }], kind: 'task' }, { model: 'flat', cap: '5', note: 'Hi' }]) {
      const r = P.applyEvent(doc(), form(extra), null);
      expect(r.error).toBeUndefined();
      expect(validateProgram(r.doc)).toHaveProperty('doc');
    }
  });
});

describe('changing the document', () => {
  it('adds an event with an id made from the title, unique, and leaves the old document alone', () => {
    const before = doc();
    const r = P.applyEvent(before, form({ title: 'Quiz' }), null);
    expect(r.id).toBe('quiz-2');
    expect(r.doc.events).toHaveLength(4);
    expect(r.doc.events[3]).toMatchObject({ id: 'quiz-2', title: 'Quiz', model: 'rate', rate: 8, block: 12 });
    expect(before).toEqual(doc());
  });
  it('an edited event keeps its id, even when the title changes, and keeps its place', () => {
    const r = P.applyEvent(doc(), form({ title: 'Table football', model: 'flat', cap: '9' }), 'table-tennis');
    expect(r.error).toBeUndefined();
    expect(r.doc.events.map((e: any) => e.id)).toEqual(['quiz', 'table-tennis', 'chess']);
    expect(r.doc.events[1]).toEqual({ id: 'table-tennis', day: 'day1', title: 'Table football', room: 'Hall', from: '10:00', to: '11:00', model: 'flat', cap: 9 });
  });
  it('editing an event that is gone says so', () => {
    expect(P.applyEvent(doc(), form(), 'deleted').error).toMatch(/no longer/);
  });
  it('a refused event changes nothing', () => {
    expect(P.applyEvent(doc(), form({ rate: '' }), null).doc).toBeUndefined();
  });
  it('stops at 300 events', () => {
    const d = doc();
    d.events = Array.from({ length: 300 }, (_, i) => ({ id: 'e' + i, day: 'day1', title: 'E' + i, room: 'R', from: '08:00', to: '09:00', model: 'flat', cap: 1 })) as any;
    expect(P.applyEvent(d, form(), null).error).toMatch(/300/);
  });
  it('removes one event, or all of them while the rest stays', () => {
    const one = P.removeEvent(doc(), 'quiz');
    expect(one.doc.events.map((e: any) => e.id)).toEqual(['table-tennis', 'chess']);
    expect(P.removeEvent(doc(), 'nope').error).toBeDefined();
    const none = P.clearEvents(doc());
    expect(none.doc.events).toEqual([]);
    expect(none.doc).toMatchObject({ title: 'Spring event', days: doc().days, goal: doc().goal });
  });
});

describe('the settings', () => {
  it('reads the document into a form and applies it back', () => {
    const f = P.settingsForm(doc());
    expect(f).toMatchObject({ title: 'Spring event', total: '60', dayKey: 'day2', dayMin: '30' });
    expect(P.applySettings(doc(), f).doc).toEqual(doc());
  });
  it('changes the title, goal and days and leaves the events', () => {
    const f = P.settingsForm(doc());
    Object.assign(f, { title: ' New title ', total: '80', dayMin: '40' });
    f.days[0].label = 'Friday';
    f.days.push({ key: ' Day3 ', label: 'Sunday', date: '2026-04-12', isNew: true });
    const r = P.applySettings(doc(), f);
    expect(r.error).toBeUndefined();
    expect(r.doc.title).toBe('New title');
    expect(r.doc.goal).toEqual({ total: 80, dayKey: 'day2', dayMin: 40 });
    expect(r.doc.days).toEqual([{ key: 'day1', label: 'Friday', date: '2026-04-10' }, doc().days[1], { key: 'day3', label: 'Sunday', date: '2026-04-12' }]);
    expect(r.doc.events).toEqual(doc().events);
    expect(validateProgram(r.doc)).toHaveProperty('doc');
  });
  it('refuses what the server would refuse', () => {
    const err = (change: (f: any) => void) => { const f = P.settingsForm(doc()); change(f); return P.applySettings(doc(), f).error; };
    expect(err(f => { f.title = ' '; })).toMatch(/title/);
    expect(err(f => { f.total = ''; })).toMatch(/total/);
    expect(err(f => { f.dayMin = 'x'; })).toMatch(/points needed/);
    expect(err(f => { f.days[0].date = '2026-02-30'; })).toMatch(/Day 1 needs a date/);
    expect(err(f => { f.days[0].label = ''; })).toMatch(/Day 1 needs a label/);
    expect(err(f => { f.days[1].key = 'day1'; f.dayKey = 'day1'; })).toMatch(/twice/);
    expect(err(f => { f.days.push({ key: 'Bad Key', label: 'X', date: '2026-04-12', isNew: true }); })).toMatch(/Day 3 needs a short key/);
    expect(err(f => { for (const k of ['a', 'b', 'c']) f.days.push({ key: k, label: k, date: '2026-04-12', isNew: true }); })).toMatch(/1 to 4 days/);
    expect(err(f => { f.dayKey = 'nope'; })).toMatch(/day of the goal/);
  });
  it('does not let a day go while events are on it, or while the goal uses it', () => {
    const f = P.settingsForm(doc());
    f.days.splice(0, 1);                       // day1 still has two events
    expect(P.applySettings(doc(), f).error).toMatch(/2 events .*not in the program/);
    const g = P.settingsForm(doc());
    g.days.splice(1, 1);                       // day2 holds the goal and the quiz
    expect(P.applySettings(doc(), g).error).toBeDefined();
    const empty = doc(); empty.events = [];
    const h = P.settingsForm(empty);
    h.days.splice(0, 1);
    expect(P.applySettings(empty, h).error).toBeUndefined();
  });
});

describe('JSON export and import', () => {
  it('exports formatted JSON without the server-added updatedAt, and it reads back the same', () => {
    const text = P.toJson({ ...doc(), updatedAt: '2026-04-01T00:00:00.000Z' });
    expect(text).not.toContain('updatedAt');
    expect(text).toContain('\n  "title"');
    expect(P.parseImport(text).doc).toEqual(doc());
  });
  it('the example in the window is a program the server accepts', () => {
    expect(validateProgram(P.EXAMPLE)).toHaveProperty('doc');
    expect(P.parseImport(JSON.stringify(P.EXAMPLE, null, 2)).doc).toEqual(P.EXAMPLE);
  });
  it('says what is wrong with pasted text', () => {
    expect(P.parseImport('   ').error).toMatch(/Paste/);
    expect(P.parseImport('{ "title": ').error).toMatch(/not valid JSON/);
    expect(P.parseImport('[{"id":"a"}]').error).toMatch(/list of events/);
    expect(P.parseImport('42').error).toMatch(/one JSON object/);
    expect(P.parseImport('null').error).toMatch(/one JSON object/);
    expect(P.parseImport('{"title":"x"}').error).toMatch(/"events"/);
  });
  it('leaves the checking of the content to the server', () => {
    const r = P.parseImport('{"title":"x","days":[],"goal":{},"events":[]}');
    expect(r.doc).toBeDefined();
    expect(validateProgram(r.doc)).toHaveProperty('error');
  });
});

describe('zones as JSON', () => {
  const zones = [{ id: 'z1', name: 'Table tennis', settings: { pointsPerBlock: 8, blockMinutes: 12 }, terminals: 2, inside: 1 }];
  it('exports name and settings only, in the shape the import takes', () => {
    const text = P.zonesToJson(zones);
    expect(JSON.parse(text)).toEqual({ zones: [{ name: 'Table tennis', settings: { pointsPerBlock: 8, blockMinutes: 12 } }] });
    expect(P.parseZonesImport(text).body).toEqual(JSON.parse(text));
  });
  it('the example is an import the page accepts', () => {
    expect(P.parseZonesImport(JSON.stringify(P.ZONES_EXAMPLE)).body).toEqual(P.ZONES_EXAMPLE);
  });
  it('says what is wrong with pasted text', () => {
    expect(P.parseZonesImport('').error).toMatch(/Paste/);
    expect(P.parseZonesImport('{').error).toMatch(/not valid JSON/);
    expect(P.parseZonesImport('[]').error).toMatch(/"zones" list/);
    expect(P.parseZonesImport('{"zones":5}').error).toMatch(/"zones" list/);
    expect(P.parseZonesImport('{"zones":[]}').error).toMatch(/empty/);
    expect(P.parseZonesImport(JSON.stringify({ zones: Array.from({ length: 101 }, () => ({})) })).error).toMatch(/100/);
  });
});
