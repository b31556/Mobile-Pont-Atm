import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';

/**
 * Live updates for the admin site. The server only says WHAT changed ("cards", "transactions" ...); each admin page
 * then asks for its own data again, so no page logic is duplicated here and a missed message can never leave a page
 * wrong for long (the page also refreshes after it reconnects).
 */
export type Topic = 'cards' | 'transactions' | 'terminals' | 'devices' | 'presence' | 'zones' | 'suggestions' | 'staff';

/** WebSocket close codes the admin page understands. */
export const CLOSE_SIGN_IN = 4401;   // the token is missing, wrong, expired or revoked: do not reconnect with it
export const CLOSE_BUSY = 4429;      // too many connections

const MAX_PER_STAFF = 10;
const MAX_TOTAL = 200;
const MAX_WAITING_PER_ADDRESS = 10;  // connections that have not signed in yet

export interface LiveOptions { authTimeoutMs?: number; flushMs?: number; pingMs?: number }

interface Conn { socket: WebSocket; ip: string; staffId?: string; alive: boolean; timers: NodeJS.Timeout[] }

export class LiveHub {
  private conns = new Set<Conn>();
  private pending = new Set<Topic>();
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSent = new Map<string, number>();
  private trailing = new Map<string, NodeJS.Timeout>();
  private held = new Map<string, Set<Topic>>();
  private pingTimer: NodeJS.Timeout | null = null;
  readonly authTimeoutMs: number;
  private flushMs: number;
  private pingMs: number;

  constructor(o: LiveOptions = {}) {
    this.authTimeoutMs = o.authTimeoutMs ?? 5000;
    this.flushMs = o.flushMs ?? 100;
    this.pingMs = o.pingMs ?? 25_000;
  }

  /**
   * Tells every signed-in admin page that these topics changed. Changes that arrive together are sent as one message.
   * [throttle] is for chatty sources (heartbeats): the first goes out at once, the rest are folded into at most one per [everyMs].
   */
  notify(topics: Topic[], throttle?: { key: string; everyMs: number }): void {
    if (!throttle) { this.queue(topics); return; }
    const { key, everyMs } = throttle;
    const now = Date.now(), last = this.lastSent.get(key) ?? -Infinity;
    if (now - last >= everyMs) { this.lastSent.set(key, now); this.queue(topics); return; }
    const held = this.held.get(key) ?? new Set<Topic>();
    for (const t of topics) held.add(t);
    this.held.set(key, held);
    if (this.trailing.has(key)) return;      // one is already on its way
    const timer = setTimeout(() => {
      this.trailing.delete(key);
      this.lastSent.set(key, Date.now());
      const waiting = this.held.get(key);
      this.held.delete(key);
      if (waiting) this.queue([...waiting]);
    }, everyMs - (now - last));
    timer.unref();
    this.trailing.set(key, timer);
  }

  private queue(topics: Topic[]): void {
    for (const t of topics) this.pending.add(t);
    if (this.flushTimer || !this.pending.size) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.flushMs);
    this.flushTimer.unref();
  }

  private flush(): void {
    if (!this.pending.size) return;
    const message = JSON.stringify({ type: 'changed', topics: [...this.pending], at: new Date().toISOString() });
    this.pending.clear();
    for (const c of [...this.conns]) {
      if (!c.staffId) continue;
      if (c.socket.bufferedAmount > 1_000_000) { c.socket.terminate(); continue; }   // a client that does not read
      try { c.socket.send(message); } catch { /* it is closing */ }
    }
  }

  add(socket: WebSocket, ip: string): Conn | null {
    if (this.conns.size >= MAX_TOTAL) return null;
    if ([...this.conns].filter(c => !c.staffId && c.ip === ip).length >= MAX_WAITING_PER_ADDRESS) return null;
    const conn: Conn = { socket, ip, alive: true, timers: [] };
    this.conns.add(conn);
    socket.on('pong', () => { conn.alive = true; });
    socket.once('close', () => this.remove(conn));
    return conn;
  }

  private remove(conn: Conn): void {
    for (const t of conn.timers) clearTimeout(t);
    this.conns.delete(conn);
  }

  countFor(staffId: string): number { return [...this.conns].filter(c => c.staffId === staffId).length; }
  get size(): number { return this.conns.size; }

  /** Hangs up everything of one person, e.g. when their password was reset or their account switched off. */
  disconnectStaff(staffId: string): void {
    for (const c of [...this.conns]) if (c.staffId === staffId) c.socket.close(CLOSE_SIGN_IN, 'Sign in again');
  }

  closeAll(): void {
    for (const c of [...this.conns]) c.socket.close(1001, 'Server is stopping');
  }

  /** Protocol pings keep the connection alive through proxies and find clients that vanished without saying goodbye. */
  startPings(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      for (const c of [...this.conns]) {
        if (!c.alive) { c.socket.terminate(); continue; }
        c.alive = false;
        try { c.socket.ping(); } catch { /* it is closing */ }
      }
    }, this.pingMs);
    this.pingTimer.unref();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const t of this.trailing.values()) clearTimeout(t);
    this.trailing.clear();
    this.closeAll();
  }
}

/**
 * Which topics a finished request changed, or null when it changed nothing an admin page shows.
 * Called for every request, so a new write route is covered without touching this file when its path is under one of these.
 */
export function changeFor(method: string, url: string, status: number): { topics: Topic[]; throttle?: { key: string; everyMs: number } } | null {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') return null;
  const path = url.split('?')[0];
  const under = (p: string) => path === p || path.startsWith(p + '/');
  // A tap on a reader or check-in phone also records unregistered cards (answered 404) and refusals, so it counts unless the server failed.
  if (path === '/fixed/tap' || path === '/presence/tap') return status < 500 ? { topics: ['cards', 'transactions', 'presence', 'suggestions', 'terminals'] } : null;
  if (path === '/info/tap') return status < 500 ? { topics: ['suggestions', 'terminals'] } : null;   // reads only; an unregistered card is added to the suggestions
  if (status >= 400) return null;
  if (/^\/zones\/[^/]+\/close-all$/.test(path)) return { topics: ['presence', 'cards', 'transactions', 'zones'] };   // everyone in a zone was signed out or discarded
  if (path === '/presence/preview' || path === '/cards/import/check') return null;   // a calculation, not a change
  if (path === '/heartbeat') return { topics: ['terminals'], throttle: { key: 'heartbeat', everyMs: 20_000 } };
  if (path === '/device/hello') return { topics: ['devices', 'terminals'], throttle: { key: 'hello', everyMs: 5_000 } };
  if (under('/charges') || under('/transactions')) return { topics: ['transactions', 'cards', 'terminals'] };
  if (under('/cards')) return { topics: ['cards', 'transactions'] };
  if (under('/card-suggestions')) return { topics: ['suggestions'] };
  if (under('/terminals') || path === '/pair') return { topics: ['terminals', 'devices'] };
  if (under('/devices')) return { topics: ['devices', 'terminals'] };
  if (under('/zones')) return { topics: ['zones', 'presence', 'terminals'] };
  if (under('/presence')) return { topics: ['presence', 'cards', 'transactions'] };
  if (under('/staff')) return { topics: ['staff'] };
  return null;
}

/** The /ws endpoint (admins only) and the hook that turns every successful change into a message. */
export function registerLive(app: FastifyInstance, hub: LiveHub) {
  const db = app.db;

  app.addHook('onResponse', (req: FastifyRequest, reply: FastifyReply, done) => {
    const change = changeFor(req.method, req.raw.url ?? '', reply.statusCode);
    if (change) hub.notify(change.topics, change.throttle);
    done();
  });
  // A refused WebSocket upgrade (wrong page, plain http, ...) must end its connection: once an upgrade is attempted the
  // HTTP server stops tracking the socket, so without this it would stay open for ever and also hold up a shutdown.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.headers.upgrade && reply.statusCode !== 101) {
      reply.header('connection', 'close');
      // The upgrade code builds the response by hand, so Node does not end the socket after it for us (a 426 sent from
      // the earliest hook stayed open): end it as soon as the answer has been written.
      reply.raw.once('finish', () => { reply.raw.socket?.destroySoon(); });
    }
    return payload;
  });
  app.addHook('preClose', async () => hub.closeAll());
  app.addHook('onClose', async () => hub.stop());
  hub.startPings();

  /** Who the token belongs to, or null. The same rules as every admin request: a staff token, an active admin, not revoked. */
  function adminOf(token: unknown): { id: string; exp: number | undefined } | null {
    if (typeof token !== 'string' || !token || token.length > 2000) return null;
    let p: { kind?: string; id?: string; v?: number; exp?: number };
    try { p = app.jwt.verify(token); } catch { return null; }
    if (p.kind !== 'staff' || !p.id) return null;
    const row = db.prepare('select id, role, active, token_version from staff where id=?').get(p.id) as { id: string; role: string; active: number; token_version: number } | undefined;
    if (!row || !row.active || row.role !== 'admin' || p.v !== row.token_version) return null;
    return { id: row.id, exp: p.exp };
  }

  app.register(websocket, { options: { maxPayload: 4096 } });
  app.register(async scope => {
    scope.get('/ws', {
      websocket: true,
      // Browsers always say which page opened the connection. Only our own pages may (the token is not a cookie, but there is no reason to talk to others).
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (!origin) return;   // not a browser (a script, a test): fine, it still has to sign in
        let host = '';
        try { host = new URL(origin).host; } catch { /* handled below */ }
        if (!host || host !== req.headers.host) return reply.code(403).send({ error: 'Not allowed from that page' });
      },
    }, (socket, req) => {
      const conn = hub.add(socket, req.ip);
      if (!conn) { socket.close(CLOSE_BUSY, 'Too many connections'); return; }
      const hangUp = (code: number, reason: string) => { try { socket.close(code, reason); } catch { /* gone */ } };
      const authTimer = setTimeout(() => { if (!conn.staffId) hangUp(CLOSE_SIGN_IN, 'Sign in first'); }, hub.authTimeoutMs);
      authTimer.unref();
      conn.timers.push(authTimer);
      socket.on('error', () => { /* a reset connection: 'close' follows */ });

      socket.on('message', (data, isBinary) => {
        if (isBinary) return hangUp(1003, 'Text only');
        let msg: { type?: unknown; token?: unknown } | null;
        try { msg = JSON.parse(data.toString()); } catch { return hangUp(1003, 'Not JSON'); }
        if (!conn.staffId) {
          // The first message must be the sign-in: a browser cannot send an Authorization header on a WebSocket,
          // and a token in the address would end up in logs.
          if (msg?.type !== 'auth') return hangUp(CLOSE_SIGN_IN, 'Sign in first');
          const who = adminOf(msg.token);
          if (!who) { try { socket.send(JSON.stringify({ type: 'error', error: 'Sign in again' })); } catch { /* gone */ } return hangUp(CLOSE_SIGN_IN, 'Sign in again'); }
          if (hub.countFor(who.id) >= MAX_PER_STAFF) return hangUp(CLOSE_BUSY, 'Too many open pages');
          conn.staffId = who.id;
          if (who.exp) {   // the sign-in lasts as long as the token does
            const left = Math.min(Math.max(who.exp * 1000 - Date.now(), 0), 2 ** 31 - 1);
            const t = setTimeout(() => hangUp(CLOSE_SIGN_IN, 'Session ended'), left);
            t.unref();
            conn.timers.push(t);
          }
          socket.send(JSON.stringify({ type: 'hello' }));
        } else if (msg?.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }   // anything else is ignored
      });
    });
  });
}
