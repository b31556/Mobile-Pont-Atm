// A reader without the hardware: registers with the server the way the firmware does, shows its pairing
// code, and lets you "tap" cards by typing their UIDs. Handy for trying the admin Readers tab first.
//
//   node tools/fake-reader.mjs http://192.168.x.x:3000
//
// Its identity is kept in tools/.fake-reader.json (delete the file to become a new device).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const server = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const file = fileURLToPath(new URL('.fake-reader.json', import.meta.url));
const me = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
  deviceId: 'FA:KE:' + randomBytes(4).toString('hex').toUpperCase().match(/../g).join(':'),
  secret: randomBytes(16).toString('hex'),
};
writeFileSync(file, JSON.stringify(me));

const post = async (path, body, token) => {
  const res = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let token = '', mode = '', last = '';
const say = text => { if (text !== last) console.log('  display:', text); last = text; };

async function hello() {
  const r = await post('/device/hello', { deviceId: me.deviceId, secret: me.secret, firmware: 'fake-1.0' });
  if (r.status !== 200) return say(`Err (${r.status} ${r.body.error ?? ''})`);
  if (r.body.status === 'pending') say(r.body.code ?? 'PEnd');
  else if (r.body.status === 'revoked') { token = ''; say('OFF'); }
  else { token = r.body.terminalToken; mode = r.body.mode; say(`----   (approved as "${r.body.name}", mode ${mode})`); }
}

console.log(`Fake reader ${me.deviceId} talking to ${server}`);
await hello();
setInterval(() => hello().catch(e => say('nEt (' + e.message + ')')), 4000);

const rl = createInterface({ input: process.stdin });
console.log('Type a card UID (like 04:A2:3B:1C) and press Enter to tap it. Ctrl+C quits.');
for await (const line of rl) {
  const uid = line.trim();
  if (!uid) continue;
  if (!token) { console.log('  not approved yet: approve this reader in admin (Readers tab), then wait a few seconds'); continue; }
  const path = mode === 'presence' ? '/presence/tap' : '/fixed/tap';
  const r = await post(path, { cardUid: uid, idempotencyKey: randomUUID() }, token);
  const a = r.body.action, bal = r.body.card?.balance;
  if (r.status === 200) say(`${a}${bal !== undefined ? '  -> balance ' + bal : ''}${r.body.points ? ' (+' + r.body.points + ')' : ''}${r.body.retryInSeconds ? '  retry in ' + r.body.retryInSeconds + ' s' : ''}`);
  else say(`HTTP ${r.status}: ${r.body.error ?? ''}`);
  setTimeout(() => say('----'), 3000);
}
