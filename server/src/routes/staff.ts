import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

export function registerStaff(app: FastifyInstance) {
  const pub = 'id,name,email,role,active';
  app.get('/staff', { preHandler: app.requireAdmin }, async () =>
    app.db.prepare(`select ${pub} from staff order by name`).all());

  app.post('/staff', { preHandler: app.requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; email?: string; password?: string; role?: string };
    if (!b.name?.trim() || !b.email?.includes('@') || (b.password ?? '').length < 8 || !['admin', 'operator'].includes(b.role ?? '')) {
      return reply.code(400).send({ error: 'Name, email, role and a password of 8+ characters are required' });
    }
    if (app.db.prepare('select 1 from staff where email=?').get(b.email.toLowerCase())) {
      return reply.code(409).send({ error: 'That email is already used' });
    }
    const id = randomUUID();
    app.db.prepare('insert into staff(id,name,email,password_hash,role,active) values(?,?,?,?,?,1)')
      .run(id, b.name.trim(), b.email.toLowerCase(), bcrypt.hashSync(b.password!, 10), b.role);
    return reply.code(201).send(app.db.prepare(`select ${pub} from staff where id=?`).get(id));
  });

  app.patch('/staff/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; email?: string; role?: string; active?: boolean; password?: string };
    if (!app.db.prepare('select 1 from staff where id=?').get(id)) return reply.code(404).send({ error: 'Staff member not found' });
    if (b.role && !['admin', 'operator'].includes(b.role)) return reply.code(400).send({ error: 'Bad role' });
    if (b.password !== undefined && b.password.length < 8) return reply.code(400).send({ error: 'Password must be 8+ characters' });
    if (b.active === false && id === req.user.id) return reply.code(400).send({ error: 'You cannot switch off your own account' });
    const set: string[] = []; const vals: unknown[] = [];
    if (b.name !== undefined) { set.push('name=?'); vals.push(b.name); }
    if (b.email !== undefined) { set.push('email=?'); vals.push(b.email.toLowerCase()); }
    if (b.role !== undefined) { set.push('role=?'); vals.push(b.role); }
    if (b.active !== undefined) { set.push('active=?'); vals.push(b.active ? 1 : 0); }
    if (b.password !== undefined) { set.push('password_hash=?'); vals.push(bcrypt.hashSync(b.password, 10)); }
    if (b.password !== undefined || b.active !== undefined || b.role !== undefined) set.push('token_version=token_version+1');
    if (set.length) app.db.prepare(`update staff set ${set.join(',')} where id=?`).run(...vals, id);
    return app.db.prepare(`select ${pub} from staff where id=?`).get(id);
  });
}
