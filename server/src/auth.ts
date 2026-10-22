import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { TOO_MANY } from './limiter.js';

export type Role = 'admin' | 'operator';
export const STAFF_TOKEN_SECONDS = 12 * 60 * 60;
/** `viaTerminal`: the request was made with a paired phone's terminal token alone, with no person signed in (id is then the terminal's id). */
export interface StaffUser { id: string; name: string; role: Role; terminalId?: string; viaTerminal?: boolean }

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { kind: 'staff'; id: string; role: Role; terminalId?: string; v: number } | { kind: 'terminal'; terminalId: string };
    user: StaffUser;
  }
}
declare module 'fastify' {
  interface FastifyInstance {
    requireStaff: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOperator: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function seedStaff(db: Db, s: { name: string; email: string; password: string; role: Role }): string {
  const id = randomUUID();
  db.prepare('insert into staff(id,name,email,password_hash,role,active) values(?,?,?,?,?,1)')
    .run(id, s.name, s.email.toLowerCase(), bcrypt.hashSync(s.password, 10), s.role);
  return id;
}

/** Returns the terminal id for a valid, active terminal token, else an error message. */
export function checkTerminalToken(app: FastifyInstance, token: string): { terminalId: string } | { error: string } {
  let payload: { kind?: string; terminalId?: string };
  try { payload = app.jwt.verify(token); } catch { return { error: 'Invalid terminal token' }; }
  if (payload.kind !== 'terminal' || !payload.terminalId) return { error: 'Invalid terminal token' };
  const row = app.db.prepare('select active from terminals where id=?').get(payload.terminalId) as { active: number } | undefined;
  if (!row) return { error: 'Invalid terminal token' };
  if (!row.active) return { error: 'This phone was revoked' };
  return { terminalId: payload.terminalId };
}

export function registerAuth(app: FastifyInstance) {
  const unauthorized = (reply: FastifyReply, error = 'Sign in again') => reply.code(401).send({ error });

  async function staffCheck(req: FastifyRequest, reply: FastifyReply, want?: Role) {
    try { await req.jwtVerify(); } catch { return unauthorized(reply); }
    const p = req.user as unknown as { kind?: string; id: string; role: Role; terminalId?: string; v?: number };
    if (p.kind === 'terminal') {
      // A paired phone is trusted as itself: it can do what an operator can, on its own terminal, and nothing more.
      const t = app.db.prepare('select id,name,active from terminals where id=?').get(p.terminalId ?? '') as { id: string; name: string; active: number } | undefined;
      if (!t) return unauthorized(reply);
      if (!t.active) return unauthorized(reply, 'This phone was revoked');
      if (want === 'admin') return reply.code(403).send({ error: 'Not allowed' });
      app.db.prepare('update terminals set last_seen=? where id=?').run(new Date().toISOString(), t.id);
      req.user = { id: t.id, name: t.name, role: 'operator', terminalId: t.id, viaTerminal: true };
      return;
    }
    if (p.kind !== 'staff') return unauthorized(reply);
    const row = app.db.prepare('select id,name,role,active,token_version from staff where id=?').get(p.id) as { id: string; name: string; role: Role; active: number; token_version: number } | undefined;
    if (!row || !row.active) return unauthorized(reply, 'This account is switched off');
    if (p.v !== row.token_version) return unauthorized(reply);
    if (row.role === 'operator') {
      const t = app.db.prepare('select active from terminals where id=?').get(p.terminalId ?? '') as { active: number } | undefined;
      if (!t || !t.active) return unauthorized(reply, 'This phone was revoked');
      app.db.prepare('update terminals set last_seen=?, last_operator=? where id=?').run(new Date().toISOString(), row.name, p.terminalId);
    }
    if (want && row.role !== want) return reply.code(403).send({ error: 'Not allowed' });
    req.user = { id: row.id, name: row.name, role: row.role, terminalId: p.terminalId };
  }
  app.decorate('requireStaff', (req: FastifyRequest, reply: FastifyReply) => staffCheck(req, reply));
  app.decorate('requireAdmin', (req: FastifyRequest, reply: FastifyReply) => staffCheck(req, reply, 'admin'));
  app.decorate('requireOperator', (req: FastifyRequest, reply: FastifyReply) => staffCheck(req, reply, 'operator'));

  app.post('/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: string; password?: string; terminalToken?: string };
    const limitKey = `${req.ip}|${(b.email ?? '').toLowerCase()}`;
    if (app.loginLimiter.blocked(limitKey)) return reply.code(429).send(TOO_MANY);
    const row = app.db.prepare('select * from staff where email=?').get((b.email ?? '').toLowerCase()) as
      { id: string; name: string; password_hash: string; role: Role; active: number; token_version: number } | undefined;
    if (!row || !row.active || !bcrypt.compareSync(b.password ?? '', row.password_hash)) {
      app.loginLimiter.fail(limitKey);
      return reply.code(401).send({ error: 'Wrong email or password' });
    }
    app.loginLimiter.clear(limitKey);
    let terminalId: string | undefined;
    if (row.role === 'operator') {
      if (!b.terminalToken) return reply.code(400).send({ error: 'This phone is not paired yet' });
      const t = checkTerminalToken(app, b.terminalToken);
      if ('error' in t) return reply.code(401).send({ error: t.error });
      terminalId = t.terminalId;
    }
    const token = app.jwt.sign({ kind: 'staff', id: row.id, role: row.role, terminalId, v: row.token_version }, { expiresIn: STAFF_TOKEN_SECONDS });
    return { token, user: { id: row.id, name: row.name, role: row.role } };
  });

  app.get('/auth/me', { preHandler: app.requireStaff }, async req => req.user);
}
