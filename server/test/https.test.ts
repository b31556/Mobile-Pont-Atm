import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { parseTrustProxy } from '../src/config.js';

const SECRET = 'a-test-secret-that-is-long-enough-0123456789';

async function make(opts: { trustProxy?: boolean | string | string[]; requireHttps?: boolean } = {}) {
  const app = buildApp({ db: openDb(':memory:'), jwtSecret: SECRET, dataDir: mkdtempSync(join(tmpdir(), 'pont-')), ...opts });
  await app.ready();
  return app;
}
const https = { 'x-forwarded-proto': 'https' };

describe('TRUST_PROXY setting', () => {
  it('trusts nobody when unset or off', () => {
    for (const v of [undefined, '', '  ', '0', 'false', 'FALSE']) expect(parseTrustProxy(v)).toBe(false);
  });
  it('1 / true / loopback mean a proxy on this machine only (not every sender)', () => {
    for (const v of ['1', 'true', 'TRUE', 'loopback', ' loopback ']) expect(parseTrustProxy(v)).toBe('loopback');
  });
  it('a list names the proxies', () => {
    expect(parseTrustProxy('203.0.113.7')).toBe('203.0.113.7');
    expect(parseTrustProxy('10.0.0.1, 10.0.0.0/8 ,')).toEqual(['10.0.0.1', '10.0.0.0/8']);
  });
});

describe('REQUIRE_HTTPS', () => {
  it('refuses plain http with 426, but still answers /health', async () => {
    const app = await make({ trustProxy: 'loopback', requireHttps: true });
    const res = await app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(426);
    expect(res.json().error).toMatch(/https/);
    const post = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.c', password: 'x' } });
    expect(post.statusCode).toBe(426);                    // nothing is processed over plain http, not even a login attempt
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('serves a request the trusted proxy says came over https', async () => {
    const app = await make({ trustProxy: 'loopback', requireHttps: true });
    expect((await app.inject({ method: 'GET', url: '/admin/', headers: https })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/display', headers: https })).statusCode).toBe(200);
  });

  it('does not believe X-Forwarded-Proto from an address that is not a trusted proxy', async () => {
    const app = await make({ trustProxy: 'loopback', requireHttps: true });
    const res = await app.inject({ method: 'GET', url: '/admin/', headers: https, remoteAddress: '203.0.113.9' });
    expect(res.statusCode).toBe(426);
  });

  it('is off by default', async () => {
    const app = await make();
    expect((await app.inject({ method: 'GET', url: '/admin/' })).statusCode).toBe(200);
  });

  it('the server will not start with REQUIRE_HTTPS but no TRUST_PROXY', () => {
    for (const trust of [undefined, '0']) {
      const env: Record<string, string | undefined> = { ...process.env, JWT_SECRET: SECRET, DB_PATH: ':memory:', PORT: '0', REQUIRE_HTTPS: '1', TRUST_PROXY: trust };
      if (trust === undefined) delete env.TRUST_PROXY;
      const r = spawnSync('npx', ['tsx', 'src/index.ts'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 30000 });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/needs TRUST_PROXY/);
    }
  });
});

describe('headers and cookies over https', () => {
  it('adds Strict-Transport-Security only on https requests, without includeSubDomains', async () => {
    const app = await make({ trustProxy: 'loopback' });
    const secure = await app.inject({ method: 'GET', url: '/health', headers: https });
    expect(secure.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(await app.inject({ method: 'GET', url: '/health' }).then(r => r.headers['strict-transport-security'])).toBeUndefined();
  });

  it('adds nosniff everywhere', async () => {
    const app = await make();
    for (const url of ['/health', '/admin/', '/display', '/display-assets/display.js']) {
      expect((await app.inject({ method: 'GET', url })).headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('the display cookie is Secure when the proxy says https, and not on plain http', async () => {
    const app = await make({ trustProxy: 'loopback' });
    const db = (app as unknown as { db: ReturnType<typeof openDb> }).db;
    db.prepare("insert into terminals(id,name,place,active,display_code) values('t1','Door','',1,'123456')").run();
    const enter = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/display/enter', headers, payload: { code: '123456' } });
    expect(String((await enter(https)).headers['set-cookie'])).toMatch(/; Secure/);
    expect(String((await enter({})).headers['set-cookie'])).not.toMatch(/Secure/);
  });

  it('a client behind the proxy is counted by its real address, and a spoofed header from elsewhere is ignored', async () => {
    const app = await make({ trustProxy: 'loopback' });
    const pair = (ip: string, remoteAddress = '127.0.0.1') =>
      app.inject({ method: 'POST', url: '/pair', remoteAddress, headers: { 'x-forwarded-for': ip }, payload: { code: '000000' } });
    for (let i = 0; i < 10; i++) await pair('198.51.100.1');
    expect((await pair('198.51.100.1')).statusCode).toBe(429);
    expect((await pair('198.51.100.2')).statusCode).toBe(400);           // another real client is unaffected
    // not the proxy: the claimed address is ignored, so this caller is counted as itself and cannot dodge the limit by rotating it
    for (let i = 0; i < 10; i++) await pair(`198.51.100.${50 + i}`, '203.0.113.7');
    expect((await pair('198.51.100.99', '203.0.113.7')).statusCode).toBe(429);
  });
});
