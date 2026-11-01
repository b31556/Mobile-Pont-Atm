import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';

async function make() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pont-'));
  const app = buildApp({ db: openDb(':memory:'), jwtSecret: 'a-test-secret-that-is-long-enough-0123456789', dataDir });
  await app.ready();
  return { app, dataDir };
}
const get = (app: Awaited<ReturnType<typeof make>>['app'], url: string) => app.inject({ method: 'GET', url });

describe('the home page', () => {
  it('lists the app page, the program and the display, and not the admin', async () => {
    const { app } = await make();
    const res = await get(app, '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const order = ['/app', '/program', '/display'].map(h => res.body.indexOf(`href="${h}"`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(res.body).not.toContain('href="/admin/"');
  });
});

describe('the app page', () => {
  it('offers Pont Card, big, and nothing else', async () => {
    const { app } = await make();
    const res = await get(app, '/app');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain('class="btn big" id="dl-card"');
    expect(res.body.match(/class="btn[^"]*" id="dl-/g)).toHaveLength(1);
  });
  it('/app/ goes to /app, and the page files are served', async () => {
    const { app } = await make();
    const r = await get(app, '/app/');
    expect([r.statusCode, r.headers.location]).toEqual([301, '/app']);
    expect((await get(app, '/site-assets/site.css')).headers['content-type']).toContain('text/css');
    expect((await get(app, '/site-assets/app.js')).headers['content-type']).toMatch(/javascript/);
  });
  it('loads nothing from other sites', async () => {
    const { app } = await make();
    for (const url of ['/', '/app', '/site-assets/site.css', '/site-assets/app.js']) {
      // (an inline icon's "http://www.w3.org/2000/svg" is a label, not a request: look for things that actually load)
      expect((await get(app, url)).body, url).not.toMatch(/(src|href)=["']https?:|url\(["']?https?:|@import|fetch\(["']https?:/);
    }
  });
});

describe('downloads', () => {
  it('serves a published app as a download, and its manifest', async () => {
    const { app, dataDir } = await make();
    const dir = join(dataDir, 'downloads');
    const apk = Buffer.from('PK\x03\x04 pretend this is an apk');
    writeFileSync(join(dir, 'pont-card.apk'), apk);
    writeFileSync(join(dir, 'apps.json'), JSON.stringify({ card: { file: 'pont-card.apk', version: '0.1.1', size: apk.length, sha256: 'ab' } }));
    const res = await get(app, '/downloads/pont-card.apk');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toBe('attachment; filename="pont-card.apk"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.rawPayload.equals(apk)).toBe(true);
    const manifest = await get(app, '/downloads/apps.json');
    expect(manifest.headers['content-type']).toContain('application/json');
    expect(manifest.json().card.version).toBe('0.1.1');
  });
  it('says 404 for what is not published, shows no listing, and does not leave the folder', async () => {
    const { app, dataDir } = await make();
    writeFileSync(join(dataDir, 'secret.txt'), 'private');
    mkdirSync(join(dataDir, 'photos'), { recursive: true });
    for (const url of ['/downloads/none.apk', '/downloads/', '/downloads', '/downloads/..%2fsecret.txt', '/downloads/%2e%2e/secret.txt', '/downloads/../secret.txt', '/downloads/..%2fphotos']) {
      const res = await get(app, url);
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.body, url).not.toContain('private');
    }
  });
});

describe('the program planner page', () => {
  it('is served at /program and /program/ goes there', async () => {
    const { app } = await make();
    const res = await get(app, '/program');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body).toContain("fetch('/public/program')");
    expect(res.body).toContain('id="lanes"');
    const r = await get(app, '/program/');
    expect(r.statusCode).toBe(301); expect(r.headers.location).toBe('/program');
  });
  it('is linked from the home page', async () => {
    const { app } = await make();
    expect((await get(app, '/')).body).toContain('href="/program"');
  });
  it('only reads the program, and never asks a visitor for a card number', async () => {
    const { app } = await make();
    const body = (await get(app, '/program')).body;
    const calls = [...body.matchAll(/fetch\('([^']+)'/g)].map(m => m[1]);
    expect(new Set(calls)).toEqual(new Set(['/public/program']));
    expect(body).not.toMatch(/Authorization|Bearer/i);
    expect(body).not.toMatch(/card number|carduid|\/public\/cards|uuid/i);
  });
});

describe('the app page says what Pont Card really does', () => {
  it('describes one card, the program and what it cannot do', async () => {
    const { app } = await make();
    const body = (await get(app, '/app')).body;
    expect(body).toMatch(/keeps one card: yours/);
    expect(body).not.toMatch(/kids|more cards/i);
    expect(body).toMatch(/drag them onto your day/);
    expect(body).toMatch(/can't give, take or spend points/);
    expect(body).toContain('href="/program"');
  });
  it('shows a picture of the app: the program with a plan, and a card with its history', async () => {
    const { app } = await make();
    const body = (await get(app, '/app')).body;
    expect(body).toContain('class="a-line"');
    expect(body).toContain('DRAG ONTO YOUR DAY');
    expect(body).toContain('class="a-who"');
  });
  it('says nothing about the admin or the staff apps, on any public page', async () => {
    const { app } = await make();
    for (const url of ['/', '/app', '/program', '/display']) {
      const body = (await get(app, url)).body;
      expect(body, url).not.toMatch(/admin|staff|terminal/i);
    }
    const css = (await get(app, '/site-assets/site.css')).body;
    expect(css).not.toMatch(/\.staff/);
  });
  it('the page script only knows the card app', async () => {
    const { app } = await make();
    const js = (await get(app, '/site-assets/app.js')).body;
    expect(js).toContain("['card', 'dl-card', 'meta-card', 'Pont Card']");
    expect(js).not.toMatch(/terminal|admin/i);
  });
});
