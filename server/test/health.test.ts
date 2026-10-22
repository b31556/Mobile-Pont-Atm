import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';

describe('scaffold', () => {
  it('GET /health returns ok', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('creates all six tables', async () => {
    const { db } = await makeApp();
    const names = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map(r => r.name);
    for (const t of ['staff', 'terminals', 'pairing_codes', 'cards', 'transactions', 'presets']) {
      expect(names).toContain(t);
    }
  });

  it('terminals have an instant_preset column defaulting to 1', async () => {
    const { db } = await makeApp();
    db.prepare("insert into terminals(id,name,place,active) values('t1','Bar','',1)").run();
    const row = db.prepare("select instant_preset from terminals where id='t1'").get() as { instant_preset: number };
    expect(row.instant_preset).toBe(1);
  });
});
