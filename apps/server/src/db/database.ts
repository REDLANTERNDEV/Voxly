import { DatabaseSync } from "node:sqlite";

type DbParam = string | number | bigint | Uint8Array | null;

export interface VoxlyDatabase {
  sqlite: DatabaseSync;
  save: () => void;
  close: () => void;
}

export async function openDatabase(databasePath: string): Promise<VoxlyDatabase> {
  const sqlite = new DatabaseSync(databasePath);

  migrate(sqlite);
  seedRooms(sqlite);

  return {
    sqlite,
    save() {},
    close() {
      sqlite.close();
    }
  };
}

export function one<T extends Record<string, unknown>>(sqlite: DatabaseSync, sql: string, params: DbParam[] = []) {
  const rows = all<T>(sqlite, sql, params);
  return rows[0] ?? null;
}

export function all<T extends Record<string, unknown>>(sqlite: DatabaseSync, sql: string, params: DbParam[] = []) {
  return sqlite.prepare(sql).all(...params) as T[];
}

export function run(sqlite: DatabaseSync, sql: string, params: DbParam[] = []) {
  sqlite.prepare(sql).run(...params);
}

export function dumpTables(sqlite: DatabaseSync) {
  return {
    users: all(sqlite, "select * from users"),
    invites: all(sqlite, "select * from invites"),
    sessions: all(sqlite, "select * from sessions"),
    rooms: all(sqlite, "select * from rooms"),
    messages: all(sqlite, "select * from messages"),
    ownerClaims: all(sqlite, "select * from owner_claims"),
    auditEvents: all(sqlite, "select * from audit_events")
  };
}

function migrate(sqlite: DatabaseSync) {
  sqlite.exec(`
    create table if not exists users (
      id text primary key,
      nickname text not null,
      role text not null check (role in ('owner', 'member')),
      banned_at text
    );

    create table if not exists invites (
      id text primary key,
      token_hash text not null unique,
      label text,
      created_by_user_id text not null,
      used_by_user_id text,
      used_at text,
      expires_at text,
      revoked_at text,
      created_at text not null
    );

    create table if not exists sessions (
      id text primary key,
      token_hash text not null unique,
      user_id text not null,
      created_at text not null,
      expires_at text not null,
      revoked_at text
    );

    create table if not exists owner_claims (
      id text primary key,
      token_hash text not null unique,
      user_id text not null,
      created_at text not null,
      expires_at text not null,
      consumed_at text
    );

    create table if not exists rooms (
      id text primary key,
      name text not null,
      kind text not null check (kind in ('text', 'voice')),
      position integer not null
    );

    create table if not exists messages (
      id text primary key,
      room_id text not null,
      user_id text not null,
      body text not null,
      created_at text not null,
      edited_at text,
      deleted_at text,
      deleted_by_user_id text
    );

    create table if not exists audit_events (
      id text primary key,
      actor_user_id text,
      action text not null,
      target_user_id text,
      created_at text not null
    );
  `);

  addColumnIfMissing(sqlite, "invites", "revoked_at", "text");
  addColumnIfMissing(sqlite, "invites", "label", "text");
  addColumnIfMissing(sqlite, "messages", "edited_at", "text");
  addColumnIfMissing(sqlite, "messages", "deleted_at", "text");
  addColumnIfMissing(sqlite, "messages", "deleted_by_user_id", "text");
}

function seedRooms(sqlite: DatabaseSync) {
  const count = one<{ count: number }>(sqlite, "select count(*) as count from rooms")?.count ?? 0;
  if (count > 0) {
    return;
  }

  run(sqlite, "insert into rooms (id, name, kind, position) values (?, ?, ?, ?)", [
    "general",
    "general",
    "text",
    10
  ]);
  run(sqlite, "insert into rooms (id, name, kind, position) values (?, ?, ?, ?)", [
    "lobby",
    "Lobby",
    "voice",
    20
  ]);
}

function addColumnIfMissing(sqlite: DatabaseSync, table: string, column: string, definition: string) {
  const columns = all<{ name: string }>(sqlite, `pragma table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}
