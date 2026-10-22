import Database from 'better-sqlite3';

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
  instant_preset integer not null default 1, last_operator text, presets_saved integer not null default 0
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
  idempotency_key text, created_at text not null, balance_after integer not null default 0
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
create table if not exists presets(
  terminal_id text not null references terminals(id), value integer not null,
  primary key(terminal_id, value)
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
