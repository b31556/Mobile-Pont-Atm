import { describe, it, expect } from 'vitest';
import { makeApp, makeOperator, auth } from './helpers.js';
import { validateProgram } from '../src/program.js';
import { DEFAULT_PROGRAM } from '../src/program-default.js';

const good = () => JSON.parse(JSON.stringify(DEFAULT_PROGRAM));
const rate = (over: object = {}) => ({ id: 'x1', day: 'day2', title: 'Chess', room: 'Library', from: '09:00', to: '10:00', model: 'rate', rate: 8, block: 12, ...over });

describe('the built-in program', () => {
  it('is valid, and shows every kind of scoring', () => {
    const r = validateProgram(DEFAULT_PROGRAM);
    expect('doc' in r).toBe(true);
    if ('doc' in r) {
      expect(r.doc.events.length).toBe(DEFAULT_PROGRAM.events.length);
      expect(new Set(r.doc.events.map(e => e.model))).toEqual(new Set(['rate', 'tasks', 'flat']));
      expect(r.doc.goal.dayKey).toBe(DEFAULT_PROGRAM.goal.dayKey);
    }
  });
});

describe('GET /public/program', () => {
  it('needs no sign-in and a fresh server starts with the example program', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/public/program' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age/);
    const b = res.json();
    expect(b.title).toBe(DEFAULT_PROGRAM.title);
    expect(b.events).toHaveLength(DEFAULT_PROGRAM.events.length);
    expect(b.days.map((d: { key: string }) => d.key)).toEqual(DEFAULT_PROGRAM.days.map(d => d.key));
    expect(typeof b.updatedAt).toBe('string');
  });
  it('is limited per address', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 120; i++) expect((await app.inject({ method: 'GET', url: '/public/program' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/public/program' })).statusCode).toBe(429);
  });
});

describe('PUT /program', () => {
  it('is for admins only', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    expect((await app.inject({ method: 'PUT', url: '/program', payload: good() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/program', headers: auth(op.token), payload: good() })).statusCode).toBe(403);
  });
  it('replaces the program, and readers see the new one', async () => {
    const { app, adminToken } = await makeApp();
    const doc = good(); doc.title = 'Spring fair'; doc.events = [rate()]; 
    const put = await app.inject({ method: 'PUT', url: '/program', headers: auth(adminToken), payload: doc });
    expect(put.statusCode).toBe(200);
    const b = (await app.inject({ method: 'GET', url: '/public/program' })).json();
    expect(b.title).toBe('Spring fair'); expect(b.events).toHaveLength(1); expect(b.events[0]).toMatchObject({ id: 'x1', rate: 8, block: 12 });
  });
  it('keeps the old program when the new one is wrong', async () => {
    const { app, adminToken } = await makeApp();
    const doc = good(); doc.events[0].to = '07:00';
    const put = await app.inject({ method: 'PUT', url: '/program', headers: auth(adminToken), payload: doc });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/Event 1 \(Table tennis/);
    expect((await app.inject({ method: 'GET', url: '/public/program' })).json().events).toHaveLength(DEFAULT_PROGRAM.events.length);
  });
});

describe('what is accepted', () => {
  const withEvents = (...events: object[]) => ({ ...good(), events });
  const bad = (doc: unknown) => { const r = validateProgram(doc); return 'error' in r ? r.error : null; };
  it('needs a title, days and a goal that match', () => {
    expect(bad({ ...good(), title: '' })).toMatch(/title/);
    expect(bad({ ...good(), days: [] })).toMatch(/days/);
    expect(bad({ ...good(), days: [{ key: 'a', label: 'A', date: '2026-02-30' }] })).toMatch(/day needs/);
    expect(bad({ ...good(), days: [{ key: 'a', label: 'A', date: '2026-10-21' }, { key: 'a', label: 'B', date: '2026-10-22' }] })).toMatch(/twice/);
    expect(bad({ ...good(), goal: { total: 90, dayKey: 'nope', dayMin: 50 } })).toMatch(/goal/);
    expect(bad(null)).toMatch(/title/);
  });
  it('checks each event and names it', () => {
    expect(bad(withEvents(rate({ id: 'a b' })))).toMatch(/id needs/);
    expect(bad(withEvents(rate(), rate()))).toMatch(/used twice/);
    expect(bad(withEvents(rate({ day: 'fri' })))).toMatch(/day must be/);
    expect(bad(withEvents(rate({ from: '9:00' })))).toMatch(/times/);
    expect(bad(withEvents(rate({ from: '10:00', to: '09:00' })))).toMatch(/after the start/);
    expect(bad(withEvents(rate({ rate: 0 })))).toMatch(/rate/);
    expect(bad(withEvents(rate({ cap: 1.5 })))).toMatch(/cap/);
    expect(bad(withEvents(rate({ model: 'magic' })))).toMatch(/model/);
    expect(bad(withEvents(rate({ title: '' })))).toMatch(/title/);
    expect(bad(withEvents(rate({ kind: 'blue' })))).toMatch(/kind/);
    expect(bad(withEvents(rate({ rule: 'x'.repeat(301) })))).toMatch(/rule/);
  });
  it('checks task lists and fixed awards', () => {
    const tasks = (items: unknown) => rate({ model: 'tasks', items, rate: undefined, block: undefined });
    expect(bad(withEvents(tasks([])))).toMatch(/1 to 20 items/);
    expect(bad(withEvents(tasks([{ name: 'Quiz', pts: 4, min: 0 }])))).toMatch(/each item/);
    expect(bad(withEvents(tasks([{ name: 'Quiz', pts: 4, min: 10 }])))).toBeNull();
    expect(bad(withEvents(rate({ model: 'flat', rate: undefined, block: undefined })))).toMatch(/fixed award/);
    expect(bad(withEvents(rate({ model: 'flat', cap: 12 })))).toBeNull();
  });
  it('drops fields it does not know, and trims text', () => {
    const r = validateProgram(withEvents(rate({ title: '  Chess ', secret: 'x', note: '  ' })));
    expect('doc' in r && r.doc.events[0]).toMatchObject({ title: 'Chess' });
    expect('doc' in r && 'secret' in (r.doc.events[0] as object)).toBe(false);
    expect('doc' in r && 'note' in (r.doc.events[0] as object)).toBe(false);
  });
});
