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
  it('lists the app page and the program as tiles, and the display and the admin as small links last', async () => {
    const { app } = await make();
    const res = await get(app, '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const order = ['/app', '/program', '/display', '/admin/'].map(h => res.body.indexOf(`href="${h}"`));
    expect(order.every(i => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const small = res.body.indexOf('class="small-links"');
    expect(small).toBeGreaterThan(res.body.indexOf('href="/program"'));
    expect(res.body.indexOf('href="/display"')).toBeGreaterThan(small); expect(res.body.indexOf('href="/admin/"')).toBeGreaterThan(small);
    expect(res.body.match(/class="tile"/g)).toHaveLength(2);
  });
});

describe('the app page', () => {
  it('offers Pont Card first and big, and the other two apps small at the very bottom', async () => {
    const { app } = await make();
    const res = await get(app, '/app');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    const card = res.body.indexOf('id="dl-card"'), terminal = res.body.indexOf('id="dl-terminal"'), admin = res.body.indexOf('id="dl-admin"');
    expect(card).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(card); expect(admin).toBeGreaterThan(terminal);
    expect(res.body.indexOf('class="more"')).toBeGreaterThan(res.body.indexOf('id="how"'));
    expect(res.body).toContain('class="btn big" id="dl-card"');
    expect(res.body).toContain('class="btn small" id="dl-terminal"');
    expect(res.body).toContain('class="btn small" id="dl-admin"');
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
  it('gives the other two apps a name and a button and says nothing about what they do', async () => {
    const { app } = await make();
    const body = (await get(app, '/app')).body;
    const more = body.slice(body.indexOf('class="more"'), body.indexOf('</section>', body.indexOf('class="more"')));
    expect(more).toContain('Pont Terminal'); expect(more).toContain('Pont Admin');
    expect(more).not.toMatch(/kiosk|scan|sign in|key|Excel|check people|give points|cancel/i);
    expect(body).not.toMatch(/For staff|For admins/);
  });
  it('does not list the admin on the program page or the app page menu', async () => {
    const { app } = await make();
    expect((await get(app, '/program')).body).not.toMatch(/admin/i);
    const appPage = (await get(app, '/app')).body;
    expect(appPage.slice(appPage.indexOf('<nav>'), appPage.indexOf('</nav>'))).not.toMatch(/admin/i);
  });
  it('the page script knows all three apps', async () => {
    const { app } = await make();
    const js = (await get(app, '/site-assets/app.js')).body;
    for (const k of ["['card', 'dl-card'", "['terminal', 'dl-terminal'", "['admin', 'dl-admin'"]) expect(js).toContain(k);
  });
});
