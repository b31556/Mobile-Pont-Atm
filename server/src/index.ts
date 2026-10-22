import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { seedStaff } from './auth.js';

const dbPath = process.env.DB_PATH ?? './data/pont.db';
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) { console.error('JWT_SECRET is required'); process.exit(1); }
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const app = buildApp({ db, jwtSecret, dataDir: dirname(dbPath), trustProxy: process.env.TRUST_PROXY === '1' });
const hasStaff = db.prepare('select count(*) c from staff').get() as { c: number };
if (hasStaff.c === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  seedStaff(db, { name: 'Admin', email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, role: 'admin' });
  console.log('seeded admin', process.env.ADMIN_EMAIL);
}
app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).then(a => console.log('listening', a));
