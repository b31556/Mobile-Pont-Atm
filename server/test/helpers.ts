import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';

export async function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, jwtSecret: 'test-secret' });
  await app.ready();
  return { app, db };
}
