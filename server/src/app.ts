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
import { registerPresence } from './routes/presence.js';
import { registerDevices } from './routes/devices.js';
import { registerFixed } from './routes/fixed.js';
import { registerDisplay } from './routes/display.js';
import { DisplayHub } from './display.js';

export interface AppOptions {
  db: Db; jwtSecret: string; dataDir?: string;
  /** Which proxies may report a client's address and protocol; see parseTrustProxy. `true` trusts every sender (tests only). */
  trustProxy?: boolean | string | string[];
  /** Refuse any request that did not arrive over https (as reported by a trusted proxy), except /health. */
  requireHttps?: boolean;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  app.addHook('onRequest', async (req, reply) => {
    if (opts.requireHttps && req.protocol !== 'https' && req.url !== '/health') {
      return reply.code(426).header('upgrade', 'TLS/1.2').send({ error: 'Use https://. This server does not answer over plain http.' });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    // Tell browsers to use https for this host from now on. No includeSubDomains: other sites live under the same domain.
    if (req.protocol === 'https') reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });
  app.decorate('db', opts.db);
  app.decorate('displayHub', new DisplayHub());
  app.decorate('loginLimiter', new AttemptLimiter(10, 15 * 60 * 1000));
  app.decorate('loginIpLimiter', new AttemptLimiter(30, 15 * 60 * 1000));   // wrong logins from one address, whatever the email
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
  registerPresence(app);
  registerDevices(app);
  registerFixed(app);
  registerDisplay(app, opts.dataDir ?? './data');
  app.register(fastifyStatic, { root: join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'display'), prefix: '/display-assets/', decorateReply: false });
  app.get('/health', async () => ({ ok: true }));
  return app;
}

declare module 'fastify' {
  interface FastifyInstance { displayHub: DisplayHub; db: Db; loginLimiter: AttemptLimiter; loginIpLimiter: AttemptLimiter; pairLimiter: AttemptLimiter }
}
