import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seedStaff } from '../src/auth.js';

export async function makeApp() {
  const db = openDb(':memory:');
  const app = buildApp({ db, jwtSecret: 'test-secret', dataDir: mkdtempSync(join(tmpdir(), 'pont-')) });
  await app.ready();
  seedStaff(db, { name: 'Admin', email: 'admin@pont.example', password: 'adminpass', role: 'admin' });
  const adminToken = await login(app, 'admin@pont.example', 'adminpass');
  return { app, db, adminToken };
}

type App = Awaited<ReturnType<typeof makeApp>>['app'];

export async function login(app: App, email: string, password: string, terminalToken?: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password, terminalToken } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return res.json().token;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Inserts an active terminal and returns its id plus a terminal token. */
export function makeTerminal(app: App, db: ReturnType<typeof openDb>, name = 'Bar 2') {
  const terminalId = randomUUID();
  db.prepare("insert into terminals(id,name,place,active) values(?,?,'',1)").run(terminalId, name);
  const terminalToken = app.jwt.sign({ kind: 'terminal', terminalId });
  return { terminalId, terminalToken };
}

/** Creates an operator staff row and returns an operator token bound to a fresh terminal. */
export async function makeOperator(app: App, db: ReturnType<typeof openDb>, email = 'eszter@pont.example', terminalName = 'Bar 2') {
  seedStaff(db, { name: 'Eszter', email, password: 'pw123456', role: 'operator' });
  const t = makeTerminal(app, db, terminalName);
  const token = await login(app, email, 'pw123456', t.terminalToken);
  return { token, ...t };
}
