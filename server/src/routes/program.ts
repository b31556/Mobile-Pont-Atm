import type { FastifyInstance } from 'fastify';
import { loadProgram, saveProgram, validateProgram } from '../program.js';
import { AttemptLimiter, TOO_MANY } from '../limiter.js';

/** The event program: anyone can read it (the app and the program page do), an admin replaces it. */
export function registerProgram(app: FastifyInstance) {
  const db = app.db;
  const calls = new AttemptLimiter(120, 5 * 60 * 1000);   // reads, per address

  app.get('/public/program', async (req, reply) => {
    if (calls.blocked(req.ip)) return reply.code(429).send(TOO_MANY);
    calls.fail(req.ip);
    const { doc, updatedAt } = loadProgram(db);
    return reply.header('cache-control', 'public, max-age=30').send({ ...doc, updatedAt });
  });

  app.put('/program', { preHandler: app.requireAdmin, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const checked = validateProgram(req.body);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const updatedAt = saveProgram(db, checked.doc);
    return { ...checked.doc, updatedAt };
  });
}
