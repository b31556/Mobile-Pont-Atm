import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { makeApp, makeOperator, auth } from './helpers.js';
import { DEFAULT_SETTINGS } from '../src/presence.js';
import { changeFor } from '../src/live.js';

type Zone = { id: string; name: string; settings: typeof DEFAULT_SETTINGS };
let ctx: Awaited<ReturnType<typeof makeApp>>;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); });

const rules = (extra: object = {}) => ({ ...DEFAULT_SETTINGS, ...extra });
const post = (payload: unknown, token = ctx.adminToken) => ctx.app.inject({ method: 'POST', url: '/zones/import', headers: auth(token), payload: payload as object });
const zones = async () => (await ctx.app.inject({ method: 'GET', url: '/zones', headers: auth(ctx.adminToken) })).json() as Zone[];
const make = async (name: string, settings = rules()) =>
  (await ctx.app.inject({ method: 'POST', url: '/zones', headers: auth(ctx.adminToken), payload: { name, settings } })).json() as Zone;

describe('POST /zones/import', () => {
  it('only an admin may use it', async () => {
    const op = await makeOperator(ctx.app, ctx.db);
    expect((await post({ zones: [{ name: 'Table tennis', settings: rules() }] }, op.token)).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/zones/import', payload: { zones: [] } })).statusCode).toBe(401);
    expect(await zones()).toHaveLength(1);
  });

  it('adds new zones and answers with the counts and every zone', async () => {
    const before = (await zones()).length;
    const res = await post({ zones: [
      { name: 'Table tennis', settings: rules({ pointsPerBlock: 5, blockMinutes: 10, maxPointsVisit: 30 }) },
      { name: 'Quiz room', settings: rules({ rounding: 'prorata', maxPoints24h: 40 }) },
    ] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 2, updated: 0 });
    expect(body.zones).toHaveLength(before + 2);
    const tt = (await zones()).find(z => z.name === 'Table tennis')!;
    expect(tt.settings).toEqual(rules({ pointsPerBlock: 5, blockMinutes: 10, maxPointsVisit: 30 }));
    expect(body.zones.find((z: Zone) => z.name === 'Quiz room').settings.maxPoints24h).toBe(40);
  });

  it('merges by name, ignoring letter case: the old zone keeps its id and name, only the rules change', async () => {
    const old = await make('Table tennis', rules({ pointsPerBlock: 2 }));
    const other = await make('Quiz room');
    const res = await post({ zones: [{ name: ' table TENNIS ', settings: rules({ pointsPerBlock: 9 }) }, { name: 'Library', settings: rules() }] });
    expect(res.json()).toMatchObject({ created: 1, updated: 1 });
    const all = await zones();
    const tt = all.filter(z => z.name.toLowerCase() === 'table tennis');
    expect(tt).toHaveLength(1);
    expect(tt[0]).toMatchObject({ id: old.id, name: 'Table tennis' });
    expect(tt[0].settings.pointsPerBlock).toBe(9);
    expect(all.find(z => z.id === other.id)).toBeTruthy();   // never deletes
  });

  it('never deletes zones that are not in the file', async () => {
    await make('Quiz room');
    const before = await zones();
    await post({ zones: [{ name: 'Library', settings: rules() }] });
    const after = await zones();
    expect(after.length).toBe(before.length + 1);
    for (const z of before) expect(after.find(x => x.id === z.id)).toEqual(z);
  });

  it('without settings, a new zone gets the defaults and an old one keeps its rules', async () => {
    await make('Quiz room', rules({ pointsPerBlock: 7 }));
    const res = await post({ zones: [{ name: 'Quiz room' }, { name: 'Library' }] });
    expect(res.json()).toMatchObject({ created: 1, updated: 1 });
    const all = await zones();
    expect(all.find(z => z.name === 'Quiz room')!.settings.pointsPerBlock).toBe(7);
    expect(all.find(z => z.name === 'Library')!.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('is all or nothing: one bad zone refuses the lot and names the zone and the problem', async () => {
    const quiz = await make('Quiz room', rules({ pointsPerBlock: 3 }));
    const before = await zones();
    const res = await post({ zones: [
      { name: 'Library', settings: rules() },
      { name: 'Quiz room', settings: rules({ pointsPerBlock: 99 }) },
      { name: 'Gym', settings: rules({ blockMinutes: 0 }) },
    ] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Gym');
    expect(res.json().error).toContain('blockMinutes');
    expect(await zones()).toEqual(before);
    expect((await zones()).find(z => z.id === quiz.id)!.settings.pointsPerBlock).toBe(3);
  });

  it('uses the same checks as creating a zone', async () => {
    const bad: [object, string][] = [
      [rules({ rounding: 'sideways' }), 'rounding'],
      [rules({ maxPointsVisit: 0 }), 'maxPointsVisit'],
      [rules({ pointsPerBlock: 1.5 }), 'pointsPerBlock'],
      [{ pointsPerBlock: 8 }, 'blockMinutes'],
    ];
    for (const [settings, field] of bad) {
      const direct = await ctx.app.inject({ method: 'POST', url: '/zones', headers: auth(ctx.adminToken), payload: { name: 'Gym', settings } });
      const res = await post({ zones: [{ name: 'Gym', settings }] });
      expect(direct.statusCode).toBe(400);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(`Zone “Gym”: ${direct.json().error}`);
      expect(res.json().error).toContain(field);
    }
    expect((await zones()).some(z => z.name === 'Gym')).toBe(false);
    expect((await post({ zones: [{ name: 'Gym', settings: 'fast' }] })).statusCode).toBe(400);
  });

  it('refuses a missing or blank name, naming its place in the list', async () => {
    for (const z of [{ settings: rules() }, { name: '   ', settings: rules() }, { name: 42, settings: rules() }, null, 'Gym']) {
      const res = await post({ zones: [{ name: 'Library', settings: rules() }, z] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Zone 2');
    }
    expect((await zones()).some(z => z.name === 'Library')).toBe(false);
  });

  it('refuses the same name twice in one request, in any letter case', async () => {
    const before = await zones();
    const res = await post({ zones: [{ name: 'Gym', settings: rules() }, { name: 'gym ', settings: rules({ pointsPerBlock: 3 }) }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('gym');
    expect(res.json().error).toContain('twice');
    expect(await zones()).toEqual(before);
  });

  it('takes 1 to 100 zones', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Zone ${i + 1}`, settings: rules() }));
    for (const body of [{}, { zones: [] }, { zones: 'x' }, { zones: many(101) }, null]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    expect((await zones()).length).toBe(1);
    const res = await post({ zones: many(100) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 100, updated: 0 });
    expect((await zones()).length).toBe(101);
  });

  it('exports in the shape it takes: what GET /zones lists can be sent back unchanged', async () => {
    await make('Quiz room', rules({ pointsPerBlock: 4 }));
    const file = { zones: (await zones()).map(z => ({ name: z.name, settings: z.settings })) };
    const res = await post(file);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: 0, updated: file.zones.length });
  });
});

describe('the live updates know about it', () => {
  it('changeFor reports a successful import as a zones change, and a refused one as nothing', () => {
    expect(changeFor('POST', '/zones/import', 200)?.topics.slice().sort()).toEqual(['presence', 'terminals', 'zones']);
    expect(changeFor('POST', '/zones/import', 400)).toBeNull();
    expect(changeFor('POST', '/zones/import', 403)).toBeNull();
  });

  it('an open admin page is told when zones were imported, and not when it was refused', async () => {
    const ws = (await ctx.app.injectWS('/ws')) as unknown as WebSocket;
    const got: { type: string; topics?: string[] }[] = [];
    ws.on('message', d => got.push(JSON.parse(d.toString())));
    try {
      ws.send(JSON.stringify({ type: 'auth', token: ctx.adminToken }));
      const waitFor = async (n: number) => { for (let i = 0; i < 60 && got.length < n; i++) await new Promise(r => setTimeout(r, 25)); };
      await waitFor(1);
      expect(got[0]).toEqual({ type: 'hello' });
      await post({ zones: [{ name: 'Gym', settings: rules({ blockMinutes: 0 }) }] });
      await new Promise(r => setTimeout(r, 300));
      expect(got).toHaveLength(1);
      await post({ zones: [{ name: 'Gym', settings: rules() }] });
      await waitFor(2);
      expect(got[1].type).toBe('changed');
      expect(got[1].topics).toContain('zones');
    } finally { ws.close(); }
  });
});
