import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * The public pages: the home page at /, the app download page at /app, and the app files themselves at /downloads/.
 * The files are published (not part of the code) into <data folder>/downloads: the signed .apk files and an apps.json
 * saying which version each is, so the page can show it. See deploy/README.md.
 */
export function registerSite(app: FastifyInstance, dataDir: string) {
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'site');
  const home = readFileSync(join(here, 'home.html'));
  const appPage = readFileSync(join(here, 'app.html'));
  const page = (body: Buffer) => async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(body);

  app.get('/', page(home));
  app.get('/app', page(appPage));
  app.get('/app/', async (_req, reply) => reply.redirect('/app', 301));

  app.register(fastifyStatic, { root: here, prefix: '/site-assets/', decorateReply: false, cacheControl: false, setHeaders: reply => { reply.header('cache-control', 'no-cache'); } });

  const downloads = join(resolve(dataDir), 'downloads');
  mkdirSync(downloads, { recursive: true });
  app.register(fastifyStatic, {
    root: downloads, prefix: '/downloads/', decorateReply: false, cacheControl: false, index: false,
    setHeaders: (reply, path) => {
      reply.header('cache-control', 'no-cache');
      if (path.endsWith('.apk')) {
        reply.header('content-type', 'application/vnd.android.package-archive');
        reply.header('content-disposition', `attachment; filename="${basename(path)}"`);
      }
    },
  });
}
