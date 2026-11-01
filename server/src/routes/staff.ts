import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { normalizeUid } from '../uid.js';
import { findAdminByKey, keyHint } from '../adminkey.js';

export function registerStaff(app: FastifyInstance) {
  const pub = 'id,name,email,role,active';
  // key_uid itself never leaves the server: a list shows whether there is a key and its last byte
  const withKey = (r: { key_uid?: string | null } & Record<string, unknown>) => { const { key_uid, ...rest } = r; return { ...rest, hasKey: !!key_uid, keyHint: keyHint(key_uid ?? null) }; };
  const one = (id: string) => withKey(app.db.prepare(`select ${pub}, key_uid from staff where id=?`).get(id) as Record<string, unknown>);
  app.get('/staff', { preHandler: app.requireAdmin }, async () =>
    (app.db.prepare(`select ${pub}, key_uid from staff order by name`).all() as Record<string, unknown>[]).map(withKey));

  /** Sets (or replaces) the card an admin signs in with. Replacing it ends the sign-ins made with the old one. */
  app.put('/staff/:id/key', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = app.db.prepare('select role, key_uid from staff where id=?').get(id) as { role: string; key_uid: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'Staff member not found' });
    if (row.role !== 'admin') return reply.code(400).send({ error: 'Only admins can have a sign-in key' });
    const uid = normalizeUid(String(((req.body ?? {}) as { uid?: unknown }).uid ?? ''));
    if (!uid) return reply.code(400).send({ error: 'That is not a valid card UID' });
    if (app.db.prepare('select 1 from cards where uid=?').get(uid)) return reply.code(409).send({ error: 'That UID is on a points card. Use a card that is only a key.' });
    const owner = findAdminByKey(app.db, uid);
    if (owner && owner.id !== id) return reply.code(409).send({ error: `That key already belongs to ${owner.name}` });
    const changed = row.key_uid !== uid;
    app.db.prepare(`update staff set key_uid=?${changed && row.key_uid ? ', token_version=token_version+1' : ''} where id=?`).run(uid, id);
    app.db.prepare('delete from card_suggestions where uid=?').run(uid);
    if (changed && row.key_uid) app.live.disconnectStaff(id);
    return one(id);
  });

  /** Takes the key away. Everyone who signed in with it is signed out (and so is the admin, if it is their own). */
  app.delete('/staff/:id/key', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = app.db.prepare('select key_uid from staff where id=?').get(id) as { key_uid: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'Staff member not found' });
    if (row.key_uid) {
      app.db.prepare('update staff set key_uid=null, token_version=token_version+1 where id=?').run(id);
      app.live.disconnectStaff(id);
    }
    return one(id);
  });

  app.post('/staff', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; email?: string; password?: string; role?: string };
    if (!b.name?.trim() || !b.email?.includes('@') || (b.password ?? '').length < 8 || !['admin', 'operator'].includes(b.role ?? '')) {
      return reply.code(400).send({ error: 'Name, email, role and a password of 8+ characters are required' });
    }
    const hash = await bcrypt.hash(b.password!, 10);   // before the check below, so check and insert stay in one step
    if (app.db.prepare('select 1 from staff where email=?').get(b.email.toLowerCase())) {
      return reply.code(409).send({ error: 'That email is already used' });
    }
    const id = randomUUID();
    app.db.prepare('insert into staff(id,name,email,password_hash,role,active) values(?,?,?,?,?,1)')
      .run(id, b.name.trim(), b.email.toLowerCase(), hash, b.role);
    return reply.code(201).send(one(id));
  });

  app.patch('/staff/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; email?: string; role?: string; active?: boolean; password?: string };
    if (!app.db.prepare('select 1 from staff where id=?').get(id)) return reply.code(404).send({ error: 'Staff member not found' });
    if (b.role && !['admin', 'operator'].includes(b.role)) return reply.code(400).send({ error: 'Bad role' });
    if (b.password !== undefined && b.password.length < 8) return reply.code(400).send({ error: 'Password must be 8+ characters' });
    if (b.active === false && id === req.user.id) return reply.code(400).send({ error: 'You cannot switch off your own account' });
    const newHash = b.password !== undefined ? await bcrypt.hash(b.password, 10) : undefined;
    const set: string[] = []; const vals: unknown[] = [];
    if (b.name !== undefined) { set.push('name=?'); vals.push(b.name); }
    if (b.email !== undefined) { set.push('email=?'); vals.push(b.email.toLowerCase()); }
    if (b.role !== undefined) { set.push('role=?'); vals.push(b.role); }
    if (b.active !== undefined) { set.push('active=?'); vals.push(b.active ? 1 : 0); }
    if (b.password !== undefined) { set.push('password_hash=?'); vals.push(newHash); }
    if (b.password !== undefined || b.active !== undefined || b.role !== undefined) set.push('token_version=token_version+1');
    if (set.length) app.db.prepare(`update staff set ${set.join(',')} where id=?`).run(...vals, id);
    if (b.password !== undefined || b.active !== undefined || b.role !== undefined) app.live.disconnectStaff(id);   // their old sign-in no longer works, so their open pages stop too
    return one(id);
  });
}
