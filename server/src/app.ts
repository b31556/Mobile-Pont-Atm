import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import type { Db } from './db.js';

export interface AppOptions { db: Db; jwtSecret: string }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorate('db', opts.db);
  app.register(jwt, { secret: opts.jwtSecret });
  app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });
  app.get('/health', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { db: Db }
}
