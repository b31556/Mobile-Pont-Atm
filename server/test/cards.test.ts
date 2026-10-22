import { describe, it, expect } from 'vitest';
import { makeApp, auth, makeOperator } from './helpers.js';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function multipart(filename: string, type: string, data: Buffer) {
  const boundary = '----pont';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function addCard(app: any, token: string, body: object = {}) {
  return app.inject({ method: 'POST', url: '/cards', headers: auth(token), payload: { name: 'Anna Kovács', uid: '04a23b1c', points: 46, ...body } });
}

describe('cards', () => {
  it('creates a card with a normalized UID and starting points', async () => {
    const { app, adminToken } = await makeApp();
    const res = await addCard(app, adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Anna Kovács', uid: '04:A2:3B:1C', balance: 46, status: 'active' });
  });

  it('rejects a duplicate UID with 409 even in a different format', async () => {
    const { app, adminToken } = await makeApp();
    await addCard(app, adminToken);
    const dup = await addCard(app, adminToken, { name: 'Other', uid: '04:A2:3B:1C' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'That UID is already on a card' });
  });

  it('rejects an invalid UID and a missing name with 400', async () => {
    const { app, adminToken } = await makeApp();
    expect((await addCard(app, adminToken, { uid: 'xyz' })).statusCode).toBe(400);
    expect((await addCard(app, adminToken, { name: '  ' })).statusCode).toBe(400);
  });

  it('searches by name or UID fragment', async () => {
    const { app, adminToken } = await makeApp();
    await addCard(app, adminToken);
    await addCard(app, adminToken, { name: 'Bence Nagy', uid: '047F91E2' });
    const byName = (await app.inject({ method: 'GET', url: '/cards?q=bence', headers: auth(adminToken) })).json();
    expect(byName.map((c: any) => c.name)).toEqual(['Bence Nagy']);
    const byUid = (await app.inject({ method: 'GET', url: '/cards?q=a2:3b', headers: auth(adminToken) })).json();
    expect(byUid.map((c: any) => c.name)).toEqual(['Anna Kovács']);
  });

  it('blocks a card with PATCH', async () => {
    const { app, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    const res = await app.inject({ method: 'PATCH', url: `/cards/${id}`, headers: auth(adminToken), payload: { status: 'blocked' } });
    expect(res.json().status).toBe('blocked');
  });

  it('adjust adds and subtracts, and refuses to go below zero', async () => {
    const { app, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    const up = await app.inject({ method: 'POST', url: `/cards/${id}/adjust`, headers: auth(adminToken), payload: { delta: 4 } });
    expect(up.json().balance).toBe(50);
    const bad = await app.inject({ method: 'POST', url: `/cards/${id}/adjust`, headers: auth(adminToken), payload: { delta: -51 } });
    expect(bad.statusCode).toBe(400);
    const after = (await app.inject({ method: 'GET', url: '/cards', headers: auth(adminToken) })).json();
    expect(after[0].balance).toBe(50);
  });

  it('accepts a png upload and serves it back to an operator', async () => {
    const { app, db, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    const m = multipart('a.png', 'image/png', png);
    const up = await app.inject({ method: 'PUT', url: `/cards/${id}/photo`, headers: { ...auth(adminToken), ...m.headers }, payload: m.payload });
    expect(up.statusCode).toBe(200);
    const op = await makeOperator(app, db);
    const get = await app.inject({ method: 'GET', url: `/cards/${id}/photo`, headers: auth(op.token) });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(get.rawPayload, png)).toBe(0);
  });

  it('refuses a text file renamed to .png', async () => {
    const { app, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    const m = multipart('a.png', 'image/png', Buffer.from('hello, not an image'));
    const up = await app.inject({ method: 'PUT', url: `/cards/${id}/photo`, headers: { ...auth(adminToken), ...m.headers }, payload: m.payload });
    expect(up.statusCode).toBe(400);
  });

  it('serves a generated avatar svg when there is no upload', async () => {
    const { app, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    const get = await app.inject({ method: 'GET', url: `/cards/${id}/photo`, headers: auth(adminToken) });
    expect(get.headers['content-type']).toContain('image/svg+xml');
    expect(get.body).toContain('<svg');
  });

  it('photo GET without a token is 401', async () => {
    const { app, adminToken } = await makeApp();
    const id = (await addCard(app, adminToken)).json().id;
    expect((await app.inject({ method: 'GET', url: `/cards/${id}/photo` })).statusCode).toBe(401);
  });

  it('operators cannot list cards', async () => {
    const { app, db } = await makeApp();
    const op = await makeOperator(app, db);
    expect((await app.inject({ method: 'GET', url: '/cards', headers: auth(op.token) })).statusCode).toBe(403);
  });
});
