import { describe, it, expect } from 'vitest';
import { makeApp } from './helpers.js';

describe('admin website', () => {
  it('serves the admin page at /admin/', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Pont admin');
  });

  it('serves the script and stylesheet', async () => {
    const { app } = await makeApp();
    const js = await app.inject({ method: 'GET', url: '/admin/admin.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    const css = await app.inject({ method: 'GET', url: '/admin/admin.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
  });

  it('redirects / to /admin/', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/');
  });
});
