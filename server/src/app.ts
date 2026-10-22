import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './db.js';
import { AttemptLimiter } from './limiter.js';
import { registerAuth } from './auth.js';
import { registerStaff } from './routes/staff.js';
import { registerTerminals } from './routes/terminals.js';
import { registerCards } from './routes/cards.js';
import { registerCharges } from './routes/charges.js';
import { registerPresets } from './routes/presets.js';
import { registerSuggestions } from './routes/suggestions.js';

export interface AppOptions { db: Db; jwtSecret: string; dataDir?: string; trustProxy?: boolean }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  app.decorate('db', opts.db);
  app.decorate('loginLimiter', new AttemptLimiter(10, 15 * 60 * 1000));
  app.decorate('pairLimiter', new AttemptLimiter(10, 15 * 60 * 1000));
  app.register(jwt, { secret: opts.jwtSecret });
  app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'admin'), prefix: '/admin/' });
  app.get('/', async (_req, reply) => reply.redirect('/admin/'));
  registerAuth(app);
  registerStaff(app);
  registerTerminals(app);
  registerCards(app, opts.dataDir ?? './data');
  registerCharges(app);
  registerPresets(app);
  registerSuggestions(app);
  app.get('/health', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { db: Db; loginLimiter: AttemptLimiter; pairLimiter: AttemptLimiter }
}
