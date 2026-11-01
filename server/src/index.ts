import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { seedStaff } from './auth.js';
import { jwtSecretProblem, parseTrustProxy } from './config.js';

const dbPath = process.env.DB_PATH ?? './data/pont.db';
const jwtSecret = process.env.JWT_SECRET;
const secretProblem = jwtSecretProblem(jwtSecret);
if (secretProblem || !jwtSecret) { console.error(secretProblem ?? 'JWT_SECRET is required'); process.exit(1); }
if (process.env.REQUIRE_HTTPS === '1' && parseTrustProxy(process.env.TRUST_PROXY) === false) {
  console.error('REQUIRE_HTTPS=1 needs TRUST_PROXY (the reverse proxy that says a request came over https), or every request is refused.');
  process.exit(1);
}
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const app = buildApp({ db, jwtSecret, dataDir: dirname(dbPath), trustProxy: parseTrustProxy(process.env.TRUST_PROXY), requireHttps: process.env.REQUIRE_HTTPS === '1' });
const hasStaff = db.prepare('select count(*) c from staff').get() as { c: number };
if (hasStaff.c === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  seedStaff(db, { name: 'Admin', email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, role: 'admin' });
  console.log('seeded admin', process.env.ADMIN_EMAIL);
}
app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '0.0.0.0' }).then(a => console.log('listening', a));
