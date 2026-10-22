import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type Db = Database.Database;

const SCHEMA = `
create table if not exists staff(
  id text primary key, name text not null, email text not null unique,
  password_hash text not null,
  role text not null check(role in ('admin','operator')),
  active integer not null default 1,
  token_version integer not null default 0
);
create table if not exists terminals(
  id text primary key, name text not null, place text not null default '',
  active integer not null default 1, last_seen text, app_version text, device text,
  instant_preset integer not null default 1, last_operator text, presets_saved integer not null default 0,
  mode text not null default 'atm', zone_id text references zones(id), direction text not null default 'toggle'
);
create table if not exists pairing_codes(
  code text primary key, terminal_id text not null references terminals(id),
  expires_at integer not null, used integer not null default 0
);
create table if not exists cards(
  id text primary key, name text not null, uid text not null unique,
  balance integer not null default 0 check(balance >= 0),
  status text not null default 'active' check(status in ('active','blocked')),
  photo_style integer not null default 0, photo_path text, last_used text
);
create table if not exists transactions(
  id integer primary key autoincrement,
  card_id text not null references cards(id),
  amount integer not null,
  type text not null check(type in ('give','storno')),
  status text not null default 'ok' check(status in ('ok','stornoed')),
  ref integer references transactions(id),
  terminal_id text, operator_id text,
  idempotency_key text, created_at text not null, balance_after integer not null default 0,
  kind text not null default 'atm', note text, zone_id text
);
create unique index if not exists tx_idem on transactions(terminal_id, idempotency_key) where idempotency_key is not null;
create table if not exists balance_adjustments(
  id text primary key, card_id text not null references cards(id), delta integer not null,
  staff_id text, created_at text not null
);
create table if not exists card_suggestions(
  uid text primary key, terminal_id text references terminals(id),
  first_seen text not null, last_seen text not null, count integer not null default 1
);
create table if not exists zones(
  id text primary key, name text not null unique collate nocase, created_at text not null,
  points_per_block integer not null, block_minutes integer not null, rounding text not null, min_minutes integer not null,
  max_points_visit integer, max_points_24h integer, max_stay_hours integer not null, cooldown_seconds integer not null
);
create table if not exists presence_sessions(
  id integer primary key autoincrement, card_id text not null references cards(id),
  zone_id text references zones(id), in_at text not null, in_terminal text, in_key text, expired_minutes integer,
  out_at text, out_terminal text, out_key text,
  minutes integer, points integer not null default 0, raw integer not null default 0, capped_by text,
  day_total integer not null default 0, balance_after integer,
  status text not null check(status in ('open','closed','expired','discarded')),
  tx_id integer references transactions(id)
);
create unique index if not exists presence_open on presence_sessions(card_id) where status='open';
create unique index if not exists presence_in_key on presence_sessions(in_terminal, in_key) where in_key is not null;
create unique index if not exists presence_out_key on presence_sessions(out_terminal, out_key) where out_key is not null;
create table if not exists presets(
  terminal_id text not null references terminals(id), value integer not null,
  primary key(terminal_id, value)
);
`;

/** Adds a column to a table made by an older version of the app. */
function ensureColumn(db: Db, table: string, column: string, ddl: string) {
  const cols = db.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) db.exec(`alter table ${table} add column ${column} ${ddl}`);
}

/** There is always at least one zone, so a terminal switched to check-in mode always has somewhere to belong. */
function ensureDefaultZone(db: Db) {
  if (db.prepare('select 1 from zones limit 1').get()) return;
  db.prepare(`insert into zones(id,name,created_at,points_per_block,block_minutes,rounding,min_minutes,max_points_visit,max_points_24h,max_stay_hours,cooldown_seconds)
    values(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), 'Main area', new Date().toISOString(), 8, 12, 'down', 0, null, null, 12, 30);
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  ensureColumn(db, 'terminals', 'mode', "text not null default 'atm'");
  ensureColumn(db, 'transactions', 'kind', "text not null default 'atm'");
  ensureColumn(db, 'transactions', 'note', 'text');
  ensureColumn(db, 'terminals', 'zone_id', 'text references zones(id)');
  ensureColumn(db, 'terminals', 'direction', "text not null default 'toggle'");
  ensureColumn(db, 'transactions', 'zone_id', 'text');
  ensureDefaultZone(db);
  return db;
}
