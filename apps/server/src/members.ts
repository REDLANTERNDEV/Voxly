/**
 * Who belongs to a server, what they are allowed to do there, and whether they
 * are online.
 *
 * Membership is server-scoped and a user account is global, so every one of
 * these answers needs both facts. Keeping them in one module means an
 * authorization rule is changed in a single place rather than re-derived by
 * each route and socket handler that needs it.
 */

import type { FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import type { PresenceStatus, PresenceUser, UserRole } from "@voxly/shared";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";

export type ServerMemberRow = {
  server_id: string;
  user_id: string;
  role: "owner" | "member";
  banned_at: string | null;
  removed_at: string | null;
  moderator_muted: number;
  moderator_deafened: number;
  can_invite: number;
};

export function activateServerMembership(
  database: VoxlyDatabase,
  serverId: string,
  userId: string,
  role: "owner" | "member",
  joinedAt: string
) {
  run(
    database.sqlite,
    `insert into server_members (server_id, user_id, role, joined_at)
     values (?, ?, ?, ?)
     on conflict(server_id, user_id) do update set removed_at = null`,
    [serverId, userId, role, joinedAt]
  );
}

export function serverMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  return one<ServerMemberRow>(
    sqlite,
    `select server_id, user_id, role, banned_at, removed_at,
      moderator_muted, moderator_deafened, can_invite
     from server_members where server_id = ? and user_id = ?`,
    [serverId, userId]
  );
}

/**
 * A global ban must reach live sockets, not just the next HTTP request.
 *
 * `authenticate()` re-reads `users.banned_at` per request, but Socket.IO runs its
 * middleware once per *connection* and freezes `socket.data.user`. Without this
 * check a banned user keeps reading messages, joins voice, and completes WebRTC
 * signalling for as long as the connection stays open. Fails closed on a missing
 * row.
 */
function isGloballyBanned(sqlite: DatabaseSync, userId: string) {
  const user = one<{ banned_at: string | null }>(sqlite, "select banned_at from users where id = ?", [userId]);
  return !user || Boolean(user.banned_at);
}

export function activeServerMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  const membership = serverMembership(sqlite, serverId, userId);
  if (!membership || membership.banned_at || membership.removed_at) return null;
  return isGloballyBanned(sqlite, userId) ? null : membership;
}

/**
 * Every server the user currently belongs to. Realtime uses it to decide which
 * server rooms a socket joins, so a kicked or banned membership must drop out
 * here rather than being filtered by each caller.
 */
export function activeServerIds(sqlite: DatabaseSync, userId: string) {
  return all<{ server_id: string }>(
    sqlite,
    "select server_id from server_members where user_id = ? and banned_at is null and removed_at is null",
    [userId]
  ).map((membership) => membership.server_id);
}

export function isServerOwner(sqlite: DatabaseSync, serverId: string, userId: string) {
  const membership = serverMembership(sqlite, serverId, userId);
  return Boolean(membership && membership.role === "owner" && !membership.banned_at && !membership.removed_at);
}

export function hasActiveServerMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  return activeServerMembership(sqlite, serverId, userId) !== null;
}

export function requireServerMember(database: VoxlyDatabase, serverId: string, userId: string, reply: FastifyReply) {
  const membership = serverMembership(database.sqlite, serverId, userId);
  if (!membership || membership.removed_at || membership.banned_at) {
    reply.code(403).send({ error: "server_forbidden" });
    return null;
  }
  return membership;
}

export function requireServerOwner(database: VoxlyDatabase, serverId: string, userId: string, reply: FastifyReply) {
  const membership = requireServerMember(database, serverId, userId, reply);
  if (!membership) return null;
  if (membership.role !== "owner") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return membership;
}

/**
 * Owners already hold every permission, so the per-member grant only decides
 * anything for an ordinary member. Callers report this effective answer rather
 * than the raw `can_invite` column.
 */
export function mayCreateInvites(role: UserRole, grant: number | boolean) {
  return role === "owner" || Boolean(grant);
}

/**
 * Invite creation is the one privileged action an owner can delegate. Listing
 * and revoking links stays owner-only: a delegated inviter can add people but
 * cannot audit or undo anyone else's links.
 */
export function requireServerInviter(database: VoxlyDatabase, serverId: string, userId: string, reply: FastifyReply) {
  const membership = requireServerMember(database, serverId, userId, reply);
  if (!membership) return null;
  if (!mayCreateInvites(membership.role, membership.can_invite)) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return membership;
}

interface PresenceUserRow extends Record<string, unknown>, Omit<PresenceUser, "canInvite" | "isBot"> {
  canInvite: number;
  isBot: number;
}

const presenceColumns = `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role,
      server_members.can_invite as canInvite,
      users.is_bot as isBot`;

function toPresenceUser(row: PresenceUserRow): PresenceUser {
  return {
    userId: row.userId,
    nickname: row.nickname,
    role: row.role,
    canInvite: Boolean(row.canInvite),
    isBot: Boolean(row.isBot)
  };
}

export function serverPresenceUser(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  const row = one<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null`,
    [serverId, userId]
  );
  return row ? toPresenceUser(row) : null;
}

export function serverPresenceUserIncludingBanned(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  const row = one<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.removed_at is null`,
    [serverId, userId]
  );
  return row ? toPresenceUser(row) : null;
}

/** Active members of a server, restricted to the given user ids. */
function activePresenceUsers(
  sqlite: DatabaseSync,
  serverId: string,
  userIds: Iterable<string>
): PresenceUser[] {
  const activeIds = new Set(userIds);
  if (activeIds.size === 0) return [];
  return all<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null
     order by nickname asc`,
    [serverId]
  ).filter((user) => activeIds.has(user.userId)).map(toPresenceUser);
}

/**
 * Every connected user and the sockets they hold. `idleSockets` is a subset of
 * `sockets`: a member is away only when every one of their connections says so,
 * so a second, active tab keeps them online.
 */
export type OnlineRegistry = Map<string, { user: PresenceUser; sockets: Set<string>; idleSockets: Set<string> }>;

export function presenceStatusOf(online: OnlineRegistry, userId: string): PresenceStatus {
  const entry = online.get(userId);
  if (!entry || entry.sockets.size === 0) return "online";
  return entry.idleSockets.size >= entry.sockets.size ? "idle" : "online";
}

export function serverPresenceUsers(
  sqlite: DatabaseSync,
  online: OnlineRegistry,
  serverId: string
) {
  return activePresenceUsers(sqlite, serverId, online.keys())
    .map((presence) => ({ ...presence, status: presenceStatusOf(online, presence.userId) }));
}

/**
 * The identity a socket carries for its whole connection, built from the
 * authenticated session. It has no server context, so it carries neither the
 * per-server invite grant nor a status.
 */
export function publicPresence(user: { id: string; nickname: string; role: UserRole; isBot: boolean }): PresenceUser {
  return {
    userId: user.id,
    nickname: user.nickname,
    role: user.role,
    isBot: user.isBot
  };
}
