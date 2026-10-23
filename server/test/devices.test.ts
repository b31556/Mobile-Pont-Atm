import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { makeApp, makeOperator, makeTerminal, auth } from './helpers.js';

const ID = 'AA:BB:CC:11:22:33';
const SECRET = 'a-long-random-device-secret-123456';
const hello = (app: any, over: object = {}, ip?: string) =>
  app.inject({ method: 'POST', url: '/device/hello', remoteAddress: ip, payload: { deviceId: ID, secret: SECRET, firmware: '1.0.0', ...over } });
const list = async (app: any, token: string) => (await app.inject({ method: 'GET', url: '/devices', headers: auth(token) })).json();
const approve = (app: any, token: string, body: object = { name: 'Entrance reader' }, id = ID) =>
  app.inject({ method: 'POST', url: `/devices/${encodeURIComponent(id)}/approve`, headers: auth(token), payload: body });

describe('a reader joins', () => {
  it('a new device is told to wait and shows up in admin with its address', async () => {
    const { app, adminToken } = await makeApp();
    const res = await hello(app, {}, '192.168.0.60');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending' });
    expect(res.json().terminalToken).toBeUndefined();
    const rows = await list(app, adminToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ID, status: 'pending', ip: '192.168.0.60', firmware: '1.0.0', online: true, terminal: null });
  });

  it('the secret is stored hashed, never in plain text', async () => {
    const { app, db } = await makeApp();
    await hello(app);
    const row = db.prepare('select secret_hash from devices').get() as { secret_hash: string };
    expect(row.secret_hash).toBe(createHash('sha256').update(SECRET).digest('hex'));
    expect(JSON.stringify(db.prepare('select * from devices').all())).not.toContain(SECRET);
  });

  it('asking again keeps one row and refreshes address and version', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app, {}, '192.168.0.60');
    await hello(app, { firmware: '1.1.0' }, '192.168.0.61');
    const rows = await list(app, adminToken);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip: '192.168.0.61', firmware: '1.1.0' });
  });

  it('a pending device gets no token before approval', async () => {
    const { app } = await makeApp();
    await hello(app);
    const again = (await hello(app)).json();
    expect(again.status).toBe('pending');
    expect(again.terminalToken).toBeUndefined();
  });

  it('a waiting device is given a 4-digit code, the same every time, and admin sees it next to the device', async () => {
    const { app, adminToken } = await makeApp();
    const first = (await hello(app)).json();
    expect(first.code).toMatch(/^[1-9]\d{3}$/);
    expect((await hello(app)).json().code).toBe(first.code);
    expect((await list(app, adminToken))[0]).toMatchObject({ status: 'pending', code: first.code });
  });

  it('waiting devices get different codes, so a code identifies one reader', async () => {
    const { app } = await makeApp();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await hello(app, { deviceId: `AA:BB:CC:00:02:${String(i).padStart(2, '0')}` })).json().code);
    expect(codes.size).toBe(20);
  });

  it('an approved device is no longer given a code, and admin stops showing one', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app); await approve(app, adminToken);
    const next = (await hello(app)).json();
    expect(next.status).toBe('approved'); expect(next.code).toBeUndefined();
    expect((await list(app, adminToken))[0].code).toBeNull();
  });

  it('a code is freed when its device is rejected, and a re-registering device gets a code again', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app);
    await app.inject({ method: 'DELETE', url: `/devices/${ID}`, headers: auth(adminToken) });
    expect((await hello(app)).json().code).toMatch(/^\d{4}$/);
  });

  it('approving gives the next hello a working terminal token, name and mode', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app);
    const a = await approve(app, adminToken, { name: 'Entrance reader', place: 'Front door' });
    expect(a.statusCode).toBe(200);
    expect(a.json().terminal).toMatchObject({ name: 'Entrance reader', mode: 'fixed' });
    const next = (await hello(app)).json();
    expect(next).toMatchObject({ status: 'approved', name: 'Entrance reader', mode: 'fixed' });
    const cfg = await app.inject({ method: 'GET', url: '/terminal/config', headers: auth(next.terminalToken) });
    expect(cfg.json()).toMatchObject({ mode: 'fixed', name: 'Entrance reader', kind: 'device' });
  });

  it('a reader can be approved as a check-in point, which puts it in the default zone', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app);
    expect((await approve(app, adminToken, { name: 'Door', mode: 'presence' })).json().terminal).toMatchObject({ mode: 'presence' });
    const cfg = (await app.inject({ method: 'GET', url: '/terminal/config', headers: auth((await hello(app)).json().terminalToken) })).json();
    expect(cfg).toMatchObject({ mode: 'presence', direction: 'toggle', zoneName: 'Main area' });
  });
});

describe('only the real device and only an admin', () => {
  it('a wrong secret for a known device is refused and gets no token', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app); await approve(app, adminToken);
    const res = await hello(app, { secret: 'a-different-secret-that-is-long-enough' });
    expect(res.statusCode).toBe(403);
    expect(res.json().terminalToken).toBeUndefined();
  });

  it('too many wrong secrets from one address lock it out', async () => {
    const { app } = await makeApp();
    await hello(app);
    for (let i = 0; i < 10; i++) expect((await hello(app, { secret: `wrong-secret-number-${i}-long-enough` })).statusCode).toBe(403);
    expect((await hello(app, { secret: 'wrong-secret-again-and-long-enough' })).statusCode).toBe(429);
    expect((await hello(app)).statusCode).toBe(429);
  });

  it('refuses nonsense ids, short secrets and non-text firmware', async () => {
    const { app } = await makeApp();
    expect((await hello(app, { deviceId: 'x' })).statusCode).toBe(400);
    expect((await hello(app, { deviceId: 'bad id with spaces!!' })).statusCode).toBe(400);
    expect((await hello(app, { secret: 'short' })).statusCode).toBe(400);
    expect((await hello(app, { firmware: 12 })).statusCode).toBe(400);
    expect((await hello(app, { firmware: 'x'.repeat(41) })).statusCode).toBe(400);
  });

  it('no more than 20 devices can wait for approval', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 20; i++) expect((await hello(app, { deviceId: `AA:BB:CC:00:01:${String(i).padStart(2, '0')}` })).statusCode).toBe(200);
    const res = await hello(app, { deviceId: 'AA:BB:CC:00:09:99' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/waiting for approval/);
    expect((await hello(app, { deviceId: 'AA:BB:CC:00:01:00' })).statusCode).toBe(200); // one that is already known still works
  });

  it('only admins list, approve or remove devices', async () => {
    const { app, db } = await makeApp();
    await hello(app);
    const op = await makeOperator(app, db);
    const phone = makeTerminal(app, db);
    for (const token of [op.token, phone.terminalToken]) {
      expect((await app.inject({ method: 'GET', url: '/devices', headers: auth(token) })).statusCode).toBe(403);
      expect((await approve(app, token)).statusCode).toBe(403);
      expect((await app.inject({ method: 'DELETE', url: `/devices/${ID}`, headers: auth(token) })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/devices' })).statusCode).toBe(401);
  });

  it('approval needs a name, a valid mode and a device that is waiting', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app);
    expect((await approve(app, adminToken, { name: '  ' })).statusCode).toBe(400);
    expect((await approve(app, adminToken, { name: 'x', mode: 'atm' })).statusCode).toBe(400);
    expect((await approve(app, adminToken, { name: 'x', mode: 'nope' })).statusCode).toBe(400);
    expect((await approve(app, adminToken, { name: 'x' }, 'AA:BB:CC:99:99:99')).statusCode).toBe(404);
    expect((await approve(app, adminToken, { name: 'x' })).statusCode).toBe(200);
    expect((await approve(app, adminToken, { name: 'y' })).statusCode).toBe(409);
  });
});

describe('removing a reader', () => {
  it('revoking cuts the reader off at once: its token stops working and hello says revoked', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app); await approve(app, adminToken);
    const token = (await hello(app)).json().terminalToken;
    expect((await app.inject({ method: 'DELETE', url: `/devices/${ID}`, headers: auth(adminToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/terminal/config', headers: auth(token) })).statusCode).toBe(401);
    const again = await hello(app);
    expect(again.json()).toEqual({ status: 'revoked' });
    expect((await list(app, adminToken))[0].status).toBe('revoked');
  });

  it('forgetting a revoked device, or rejecting a waiting one, removes the row', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app); await approve(app, adminToken);
    await app.inject({ method: 'DELETE', url: `/devices/${ID}`, headers: auth(adminToken) });
    await app.inject({ method: 'DELETE', url: `/devices/${ID}`, headers: auth(adminToken) });
    expect(await list(app, adminToken)).toHaveLength(0);
    await hello(app, { deviceId: 'AA:BB:CC:44:55:66' });
    expect((await app.inject({ method: 'DELETE', url: '/devices/AA:BB:CC:44:55:66', headers: auth(adminToken) })).statusCode).toBe(200);
    expect(await list(app, adminToken)).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: '/devices/AA:BB:CC:44:55:66', headers: auth(adminToken) })).statusCode).toBe(404);
  });

  it('revoking the terminal from the terminals API also turns the device away', async () => {
    const { app, adminToken } = await makeApp();
    await hello(app);
    const terminalId = (await approve(app, adminToken)).json().terminal.id;
    await app.inject({ method: 'DELETE', url: `/terminals/${terminalId}`, headers: auth(adminToken) });
    expect((await hello(app)).json()).toEqual({ status: 'revoked' });
  });
});

describe('phones and readers are different kinds of terminal', () => {
  it('the terminal list says which is which and carries a reader’s address and fixed-amount rules', async () => {
    const { app, db, adminToken } = await makeApp();
    makeTerminal(app, db, 'Phone');
    await hello(app, {}, '192.168.0.60'); await approve(app, adminToken, { name: 'Reader' });
    const rows = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(rows.find((t: { name: string }) => t.name === 'Phone')).toMatchObject({ kind: 'phone' });
    expect(rows.find((t: { name: string }) => t.name === 'Reader')).toMatchObject({
      kind: 'device', mode: 'fixed', ip: '192.168.0.60', firmware: '1.0.0',
      fixed: { amount: 10, cooldownSeconds: 60, maxUses24h: null, maxPoints24h: null, maxUsesTotal: null },
    });
  });

  it('a phone cannot be put in fixed-amount mode and a reader cannot be in ATM mode', async () => {
    const { app, db, adminToken } = await makeApp();
    const phone = makeTerminal(app, db, 'Phone');
    await hello(app); const reader = (await approve(app, adminToken)).json().terminal;
    const patch = (id: string, body: object) => app.inject({ method: 'PATCH', url: `/terminals/${id}`, headers: auth(adminToken), payload: body });
    expect((await patch(phone.terminalId, { mode: 'fixed' })).statusCode).toBe(400);
    expect((await patch(reader.id, { mode: 'atm' })).statusCode).toBe(400);
    expect((await patch(reader.id, { mode: 'presence' })).statusCode).toBe(200);
    expect((await patch(reader.id, { mode: 'fixed' })).statusCode).toBe(200);
  });

  it('fixed-amount settings can be changed on a reader, are validated, and are refused for phones', async () => {
    const { app, db, adminToken } = await makeApp();
    const phone = makeTerminal(app, db, 'Phone');
    await hello(app); const reader = (await approve(app, adminToken)).json().terminal;
    const patch = (id: string, body: object) => app.inject({ method: 'PATCH', url: `/terminals/${id}`, headers: auth(adminToken), payload: body });
    const good = { amount: 5, cooldownSeconds: 30, maxUses24h: 3, maxPoints24h: 15, maxUsesTotal: null };
    expect((await patch(reader.id, { fixed: good })).statusCode).toBe(200);
    const rows = (await app.inject({ method: 'GET', url: '/terminals', headers: auth(adminToken) })).json();
    expect(rows.find((t: { id: string }) => t.id === reader.id).fixed).toEqual(good);
    const bad = await patch(reader.id, { fixed: { ...good, amount: 0 } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toContain('amount');
    expect((await patch(reader.id, { fixed: 'x' })).statusCode).toBe(400);
    expect((await patch(phone.terminalId, { fixed: good })).statusCode).toBe(400);
  });
});
