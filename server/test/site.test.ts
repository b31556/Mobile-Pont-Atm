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
  it('lists the admin, the app page and the display', async () => {
    const { app } = await make();
    const res = await get(app, '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const order = ['/admin/', '/app', '/display'].map(h => res.body.indexOf(`href="${h}"`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the app page', () => {
  it('offers Pont Card first and bigger, and Pont Terminal after it', async () => {
    const { app } = await make();
    const res = await get(app, '/app');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const card = res.body.indexOf('id="dl-card"'), terminal = res.body.indexOf('id="dl-terminal"');
    expect(card).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(card);
    expect(res.body).toContain('class="btn big" id="dl-card"');
    expect(res.body).toContain('class="btn alt" id="dl-terminal"');
  });
  it('offers Pont Admin last, and the page script fills in its button', async () => {
    const { app } = await make();
    const body = (await get(app, '/app')).body;
    expect(body.indexOf('id="dl-admin"')).toBeGreaterThan(body.indexOf('id="dl-terminal"'));
    expect(body).toContain('id="meta-admin"');
    expect((await get(app, '/site-assets/app.js')).body).toContain("['admin', 'dl-admin', 'meta-admin', 'Pont Admin']");
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
    expect(res.body).toContain('id="view"');
    const r = await get(app, '/program/');
    expect(r.statusCode).toBe(301); expect(r.headers.location).toBe('/program');
  });
  it('is linked from the home page', async () => {
    const { app } = await make();
    expect((await get(app, '/')).body).toContain('href="/program"');
  });
  it('reads the program and the card from the public endpoints only', async () => {
    const { app } = await make();
    const body = (await get(app, '/program')).body;
    const calls = [...body.matchAll(/fetch\('([^']+)'/g)].map(m => m[1]);
    expect(new Set(calls)).toEqual(new Set(['/public/program', '/public/cards']));
    expect(body).not.toMatch(/Authorization|Bearer/i);
  });
});
