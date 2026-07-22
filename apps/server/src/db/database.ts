import { DatabaseSync } from "node:sqlite";

type DbParam = string | number | bigint | Uint8Array | null;

export const defaultServerId = "the-basement";
export const defaultServerName = "The Basement";

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
    servers: all(sqlite, "select * from servers"),
    serverMembers: all(sqlite, "select * from server_members"),
    users: all(sqlite, "select * from users"),
    invites: all(sqlite, "select * from invites"),
    sessions: all(sqlite, "select * from sessions"),
    rooms: all(sqlite, "select * from rooms"),
    messages: all(sqlite, "select * from messages"),
    ownerClaims: all(sqlite, "select * from owner_claims"),
    accessClaims: all(sqlite, "select * from access_claims"),
    auditEvents: all(sqlite, "select * from audit_events")
  };
}

function migrate(sqlite: DatabaseSync) {
  const needsLegacyMembershipBackfill = one<{ count: number }>(
    sqlite,
    "select count(*) as count from sqlite_master where type = 'table' and name = 'server_members'"
  )?.count === 0;

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
      consumed_at text,
      revoked_at text
    );

    create table if not exists rooms (
      id text primary key,
      server_id text,
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
      suppressed_embed_keys text not null default '[]',
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

    create table if not exists servers (
      id text primary key,
      name text not null,
      created_by_user_id text,
      created_at text not null
    );

    create table if not exists server_members (
      server_id text not null,
      user_id text not null,
      role text not null check (role in ('owner', 'member')),
      nickname text,
      banned_at text,
      removed_at text,
      joined_at text not null,
      primary key (server_id, user_id)
    );

    create table if not exists access_claims (
      id text primary key,
      token_hash text not null unique,
      user_id text not null,
      server_id text not null,
      created_by_user_id text not null,
      created_at text not null,
      expires_at text not null,
      consumed_at text
    );

  `);

  addColumnIfMissing(sqlite, "invites", "revoked_at", "text");
  addColumnIfMissing(sqlite, "invites", "label", "text");
  addColumnIfMissing(sqlite, "messages", "edited_at", "text");
  addColumnIfMissing(sqlite, "messages", "suppressed_embed_keys", "text not null default '[]'");
  addColumnIfMissing(sqlite, "messages", "deleted_at", "text");
  addColumnIfMissing(sqlite, "messages", "deleted_by_user_id", "text");
  addColumnIfMissing(sqlite, "rooms", "server_id", "text");
  addColumnIfMissing(sqlite, "invites", "server_id", "text");
  addColumnIfMissing(sqlite, "audit_events", "server_id", "text");
  addColumnIfMissing(sqlite, "access_claims", "revoked_at", "text");
  addColumnIfMissing(sqlite, "server_members", "nickname", "text");

  sqlite.exec(`
    create index if not exists idx_server_members_user
      on server_members (user_id, banned_at, removed_at);
    create index if not exists idx_rooms_server_position
      on rooms (server_id, position);
    create index if not exists idx_invites_server_created
      on invites (server_id, created_at desc);
    create index if not exists idx_messages_room_created
      on messages (room_id, created_at desc);
  `);

  const now = new Date().toISOString();
  const serverCount = one<{ count: number }>(sqlite, "select count(*) as count from servers")?.count ?? 0;
  if (serverCount === 0) {
    run(sqlite, "insert into servers (id, name, created_at) values (?, ?, ?)", [
      defaultServerId,
      defaultServerName,
      now
    ]);
  }

  const hasDefaultServer = (one<{ count: number }>(sqlite, "select count(*) as count from servers where id = ?", [defaultServerId])?.count ?? 0) > 0;
  if (hasDefaultServer) {
    run(sqlite, "update rooms set server_id = ? where server_id is null", [defaultServerId]);
    run(sqlite, "update invites set server_id = ? where server_id is null", [defaultServerId]);
    run(sqlite, "update audit_events set server_id = ? where server_id is null", [defaultServerId]);
    if (needsLegacyMembershipBackfill) {
      run(
        sqlite,
        `insert or ignore into server_members (server_id, user_id, role, banned_at, joined_at)
         select ?, id, role, banned_at, ? from users`,
        [defaultServerId, now]
      );
    }
  }
}

function seedRooms(sqlite: DatabaseSync) {
  const count = one<{ count: number }>(sqlite, "select count(*) as count from rooms")?.count ?? 0;
  if (count > 0) {
    return;
  }

  run(sqlite, "insert into rooms (id, server_id, name, kind, position) values (?, ?, ?, ?, ?)", [
    "general",
    defaultServerId,
    "general",
    "text",
    10
  ]);
  run(sqlite, "insert into rooms (id, server_id, name, kind, position) values (?, ?, ?, ?, ?)", [
    "lobby",
    defaultServerId,
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
