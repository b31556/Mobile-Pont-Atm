import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { buildApp } from './app.js';

const dbPath = process.env.DB_PATH ?? './data/pont.db';
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) { console.error('JWT_SECRET is required'); process.exit(1); }
mkdirSync(dirname(dbPath), { recursive: true });
const app = buildApp({ db: openDb(dbPath), jwtSecret });
app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' }).then(a => console.log('listening', a));
