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
import {
  roleColors,
  serverPermissions,
  type Permission,
  type RoleColor,
  type RoleKind,
  type RoleSummary
} from "@voxly/shared";
import type {
  PresenceChoiceRequest,
  PresenceChoiceState,
  PresenceStatus,
  PresenceUser,
  RoomSummary,
  UserRole
} from "@voxly/shared";
import { baselineMembershipReadState } from "./readState.js";
import { all, one, run, assignMentionCode, type VoxlyDatabase } from "./db/database.js";

export type ServerMemberRow = {
  server_id: string;
  user_id: string;
  role: "owner" | "member";
  banned_at: string | null;
  removed_at: string | null;
  moderator_muted: number;
  moderator_deafened: number;
};

export function activateServerMembership(
  database: VoxlyDatabase,
  serverId: string,
  userId: string,
  role: "owner" | "member",
  joinedAt: string
) {
  const previous = serverMembership(database.sqlite, serverId, userId);
  run(
    database.sqlite,
    `insert into server_members (server_id, user_id, role, joined_at)
     values (?, ?, ?, ?)
     on conflict(server_id, user_id) do update set removed_at = null`,
    [serverId, userId, role, joinedAt]
  );
  if (!previous || previous.removed_at) baselineMembershipReadState(database.sqlite, serverId, userId);
  assignMentionCode(database.sqlite, serverId, userId);
}

export function serverMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  return one<ServerMemberRow>(
    sqlite,
    `select server_id, user_id, role, banned_at, removed_at,
      moderator_muted, moderator_deafened
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

/*
 * Roles and Permissions (ADR-0038). The resolver every Server-scoped check
 * asks; `roles.ts` owns the routes that change them.
 */

type RoleRow = {
  id: string;
  serverId: string;
  name: string | null;
  color: string | null;
  position: number;
  separate: number;
  permissions: string;
  kind: RoleKind | null;
};

const roleColumns = `id, server_id as serverId, name, color, position, separate, permissions, kind`;

/** A stored list read defensively: anything that is not a known Permission is dropped. */
function parsePermissions(stored: string): Permission[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? serverPermissions.filter((permission) => parsed.includes(permission)) : [];
  } catch {
    return [];
  }
}

function toRoleSummary(row: RoleRow): RoleSummary {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    // A stored colour outside the palette reads as none rather than reaching a client.
    color: (roleColors as readonly string[]).includes(row.color ?? "") ? (row.color as RoleColor) : null,
    position: row.position,
    separate: Boolean(row.separate),
    permissions: parsePermissions(row.permissions),
    kind: row.kind
  };
}

/** A Server's Roles, highest first. */
export function serverRoles(sqlite: DatabaseSync, serverId: string): RoleSummary[] {
  return all<RoleRow>(sqlite, `select ${roleColumns} from roles where server_id = ? order by position desc`, [
    serverId
  ]).map(toRoleSummary);
}

export function serverRole(sqlite: DatabaseSync, serverId: string, roleId: string): RoleSummary | null {
  const row = one<RoleRow>(sqlite, `select ${roleColumns} from roles where server_id = ? and id = ?`, [
    serverId,
    roleId
  ]);
  return row ? toRoleSummary(row) : null;
}

/** The ids of the Roles a member was given, `@everyone` not included. */
export function memberRoleIds(sqlite: DatabaseSync, serverId: string, userId: string): string[] {
  return all<{ role_id: string }>(
    sqlite,
    `select member_roles.role_id from member_roles join roles on roles.id = member_roles.role_id
     where member_roles.server_id = ? and member_roles.user_id = ? order by roles.position desc`,
    [serverId, userId]
  ).map((row) => row.role_id);
}

/**
 * Who a member is in one Server, for the resolver: null when they hold no
 * active Membership. A Bot is reported as holding no Roles at all.
 */
function standing(sqlite: DatabaseSync, serverId: string, userId: string) {
  const membership = activeServerMembership(sqlite, serverId, userId);
  if (!membership) return null;
  const roles = serverRoles(sqlite, serverId);
  const isOwner = membership.role === "owner";
  const isBot = Boolean(one<{ is_bot: number }>(sqlite, "select is_bot from users where id = ?", [userId])?.is_bot);
  const held = isBot ? new Set<string>() : new Set(memberRoleIds(sqlite, serverId, userId));
  const own = roles.filter((role) => role.kind === "everyone" || held.has(role.id));
  return { roles, own, isOwner, isBot };
}

/**
 * The Permissions a member holds in a Server, in the order of the closed list.
 * Already expanded: the owner and an Administrator holder get every one.
 */
export function permissionsFor(sqlite: DatabaseSync, serverId: string, userId: string): Permission[] {
  const found = standing(sqlite, serverId, userId);
  if (!found || found.isBot) return [];
  if (found.isOwner) return [...serverPermissions];
  const held = new Set(found.own.flatMap((role) => role.permissions));
  if (held.has("administrator")) return [...serverPermissions];
  return serverPermissions.filter((permission) => held.has(permission));
}

export function hasPermission(sqlite: DatabaseSync, serverId: string, userId: string, permission: Permission) {
  return permissionsFor(sqlite, serverId, userId).includes(permission);
}

/**
 * The position of a member's highest Role: 0 for `@everyone` alone, and one
 * above the highest Role for the owner, who stands above every rank.
 */
export function rankOf(sqlite: DatabaseSync, serverId: string, userId: string): number {
  const found = standing(sqlite, serverId, userId);
  if (!found) return 0;
  if (found.isOwner) return Math.max(0, ...found.roles.map((role) => role.position)) + 1;
  return Math.max(0, ...found.own.map((role) => role.position));
}

/**
 * Whether the actor may act on the target: strictly above them. Nobody
 * outranks the owner, the owner included — an owner is never the subject of a
 * Role action — and the owner outranks every other member.
 */
export function outranks(sqlite: DatabaseSync, serverId: string, actorId: string, targetId: string) {
  const actor = activeServerMembership(sqlite, serverId, actorId);
  const target = activeServerMembership(sqlite, serverId, targetId);
  if (!actor || !target || target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return rankOf(sqlite, serverId, actorId) > rankOf(sqlite, serverId, targetId);
}

/**
 * Reply helper: an active member holding the Permission, or null once a 403
 * has been sent. Membership is checked first, so a stranger hears the same
 * `server_forbidden` as on every other server-scoped route.
 */
export function requireServerPermission(
  database: VoxlyDatabase,
  serverId: string,
  userId: string,
  permission: Permission,
  reply: FastifyReply
) {
  const membership = requireServerMember(database, serverId, userId, reply);
  if (!membership) return null;
  if (!hasPermission(database.sqlite, serverId, userId, permission)) {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return membership;
}

interface PresenceUserRow extends Record<string, unknown>, Omit<PresenceUser, "roleIds" | "isBot"> {
  roleIds: string | null;
  isBot: number;
}

/**
 * A member's Roles as one column, in no particular order: whoever needs the
 * highest reads the Server's Roles, which are sorted. A Bot holds none,
 * whatever a stray row says (ADR-0038). Shared by every shape carrying `roleIds`.
 */
export const memberRoleIdsColumn = `case when users.is_bot = 1 then null else (
        select group_concat(member_roles.role_id, ',') from member_roles
        where member_roles.server_id = server_members.server_id and member_roles.user_id = server_members.user_id
      ) end`;

export function parseRoleIds(stored: string | null) {
  return stored ? stored.split(",") : [];
}

const presenceColumns = `select users.id as userId,
      server_members.mention_code as mentionCode,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role,
      ${memberRoleIdsColumn} as roleIds,
      users.is_bot as isBot`;

function toPresenceUser(row: PresenceUserRow): PresenceUser {
  return {
    userId: row.userId,
    mentionCode: row.mentionCode,
    nickname: row.nickname,
    role: row.role,
    roleIds: parseRoleIds(row.roleIds),
    isBot: Boolean(row.isBot)
  };
}

export function serverPresenceUser(sqlite: DatabaseSync, serverId: string, userId: string): PresenceUser | null {
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
function activePresenceUsers(sqlite: DatabaseSync, serverId: string, userIds: Iterable<string>): PresenceUser[] {
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
  )
    .filter((user) => activeIds.has(user.userId))
    .map(toPresenceUser);
}

/**
 * Every connected user and the sockets they hold. `idleSockets` is a subset of
 * `sockets`: a member is away only when every one of their connections says so,
 * so a second, active tab keeps them online. `choice` is the Status the member
 * picked, which outranks what their connections measured.
 */
export type OnlineRegistry = Map<
  string,
  { user: PresenceUser; sockets: Set<string>; idleSockets: Set<string>; choice: PresenceChoiceState }
>;

const onlineChoice: PresenceChoiceState = { status: "online", until: null };

/** A Status whose time has run out reads as Online, whether or not anyone has stored that yet. */
export function currentChoice(choice: PresenceChoiceState, now = Date.now()): PresenceChoiceState {
  return choice.until !== null && Date.parse(choice.until) <= now ? onlineChoice : choice;
}

export function presenceStatusOf(online: OnlineRegistry, userId: string, now = Date.now()): PresenceStatus {
  const entry = online.get(userId);
  if (!entry || entry.sockets.size === 0) return "online";
  const choice = currentChoice(entry.choice, now).status;
  if (choice === "dnd" || choice === "idle") return choice;
  return entry.idleSockets.size >= entry.sockets.size ? "idle" : "online";
}

/**
 * Whether other members may see this user in the online list at all. An
 * invisible member is connected but reported exactly like an offline one.
 */
export function isVisiblyOnline(online: OnlineRegistry, userId: string, now = Date.now()) {
  const entry = online.get(userId);
  return Boolean(entry && entry.sockets.size > 0 && currentChoice(entry.choice, now).status !== "invisible");
}

/**
 * The connected members of a server as `viewerUserId` may see them. The viewer
 * always sees themselves, so their own row can show the Status they picked.
 */
export function serverPresenceUsers(
  sqlite: DatabaseSync,
  online: OnlineRegistry,
  serverId: string,
  viewerUserId: string
) {
  const visible = [...online.keys()].filter((userId) => userId === viewerUserId || isVisiblyOnline(online, userId));
  return activePresenceUsers(sqlite, serverId, visible).map((presence) => ({
    ...presence,
    status: presenceStatusOf(online, presence.userId)
  }));
}

/**
 * Who other members would see online right now, read from the live
 * connections rather than the registry, so a route module can ask. An
 * invisible member is passed by exactly like one who is not connected.
 */
export function visiblyOnlineUserIds(
  sqlite: DatabaseSync,
  connections: Iterable<{ data: { user?: unknown } }>,
  now = Date.now()
): Set<string> {
  const connected = new Set<string>();
  for (const connection of connections) {
    const userId = (connection.data.user as PresenceUser | undefined)?.userId;
    if (userId !== undefined) connected.add(userId);
  }
  return new Set([...connected].filter((userId) => readPresenceChoice(sqlite, userId, now).status !== "invisible"));
}

/**
 * How many people a server has, and how many of them are online. The count is
 * over people: a Bot, an ended or banned Membership and a Deleted account are
 * all left out, as in every other member count.
 */
export function serverHeadcount(sqlite: DatabaseSync, serverId: string, onlineUserIds: ReadonlySet<string>) {
  const members = all<{ userId: string }>(
    sqlite,
    `select users.id as userId
     from server_members join users on users.id = server_members.user_id
     where server_members.server_id = ?
       and server_members.banned_at is null and server_members.removed_at is null
       and users.banned_at is null and users.deleted_at is null and users.is_bot = 0`,
    [serverId]
  );
  return {
    memberCount: members.length,
    onlineCount: members.filter((member) => onlineUserIds.has(member.userId)).length
  };
}

export function readPresenceChoice(sqlite: DatabaseSync, userId: string, now = Date.now()): PresenceChoiceState {
  const row = one<{ status: PresenceChoiceState["status"]; until: string | null }>(
    sqlite,
    "select presence_choice as status, presence_choice_until as until from users where id = ?",
    [userId]
  );
  return row ? currentChoice({ status: row.status, until: row.until }, now) : onlineChoice;
}

export function presenceChoiceFor(request: PresenceChoiceRequest, now = Date.now()): PresenceChoiceState {
  if (request.status === "online") return onlineChoice;
  const until =
    request.duration.mode === "timed" ? new Date(now + request.duration.durationMinutes * 60_000).toISOString() : null;
  return { status: request.status, until };
}

export function writePresenceChoice(sqlite: DatabaseSync, userId: string, choice: PresenceChoiceState) {
  run(sqlite, "update users set presence_choice = ?, presence_choice_until = ? where id = ?", [
    choice.status,
    choice.until,
    userId
  ]);
}

/**
 * The identity a socket carries for its whole connection, built from the
 * authenticated session. It has no server context, so it carries neither the
 * member's Roles nor a status.
 */
export function publicPresence(user: { id: string; nickname: string; role: UserRole; isBot: boolean }): PresenceUser {
  return {
    userId: user.id,
    nickname: user.nickname,
    role: user.role,
    isBot: user.isBot
  };
}

/**
 * What one member may do with one channel (ADR-0037).
 *
 * `canSee`: the channel appears in their list. `canRead`: they may read its
 * history, unread state and live messages, and see who is in it. `canEnter`:
 * they may write, react and join. A public channel grants all three to every
 * active Membership; a private one grants them to the Server's owners and its
 * Channel access, and only `canSee` and `canRead` to others when it is Listed.
 */
export type RoomAccess = { canSee: boolean; canRead: boolean; canEnter: boolean };

/** The facts about a channel the access rule reads. */
export type RoomAccessSubject = Pick<RoomSummary, "id" | "serverId" | "isPrivate" | "listed">;

const noRoomAccess: RoomAccess = { canSee: false, canRead: false, canEnter: false };

export function hasRoomGrant(sqlite: DatabaseSync, roomId: string, userId: string) {
  return Boolean(
    one(sqlite, "select 1 as granted from room_access where room_id = ? and user_id = ?", [roomId, userId])
  );
}

export function roomAccess(sqlite: DatabaseSync, room: RoomAccessSubject, userId: string): RoomAccess {
  const membership = activeServerMembership(sqlite, room.serverId, userId);
  if (!membership) return noRoomAccess;
  if (!room.isPrivate || membership.role === "owner" || hasRoomGrant(sqlite, room.id, userId)) {
    return { canSee: true, canRead: true, canEnter: true };
  }
  return room.listed ? { canSee: true, canRead: true, canEnter: false } : noRoomAccess;
}

/** The Channel access of one private channel, owners not included. */
export function roomGrantUserIds(sqlite: DatabaseSync, roomId: string) {
  return all<{ user_id: string }>(sqlite, "select user_id from room_access where room_id = ? order by granted_at", [
    roomId
  ]).map((row) => row.user_id);
}

/**
 * Everyone an active Membership currently lets enter a channel: every member
 * for a public channel, otherwise owners plus its Channel access.
 */
export function roomEntrantIds(sqlite: DatabaseSync, room: Omit<RoomAccessSubject, "listed">): Set<string> {
  const rows = room.isPrivate
    ? all<{ user_id: string }>(
        sqlite,
        `select m.user_id from server_members m join users u on u.id = m.user_id
         where m.server_id = ? and m.banned_at is null and m.removed_at is null and u.banned_at is null
           and (m.role = 'owner' or exists (select 1 from room_access a where a.room_id = ? and a.user_id = m.user_id))`,
        [room.serverId, room.id]
      )
    : all<{ user_id: string }>(
        sqlite,
        `select m.user_id from server_members m join users u on u.id = m.user_id
         where m.server_id = ? and m.banned_at is null and m.removed_at is null and u.banned_at is null`,
        [room.serverId]
      );
  return new Set(rows.map((row) => row.user_id));
}

/** Everyone who may read a channel: entrants, or every member when it is public or Listed. */
export function roomReaderIds(sqlite: DatabaseSync, room: RoomAccessSubject): Set<string> {
  return roomEntrantIds(sqlite, room.isPrivate && room.listed ? { ...room, isPrivate: false } : room);
}

/**
 * Reply helper for a channel route. A channel the member cannot see answers as if
 * it did not exist, so a Hidden channel's id never confirms anything.
 */
export function requireRoomAccess(
  database: VoxlyDatabase,
  room: RoomAccessSubject,
  userId: string,
  need: "read" | "enter",
  reply: FastifyReply
) {
  if (!requireServerMember(database, room.serverId, userId, reply)) return null;
  const access = roomAccess(database.sqlite, room, userId);
  if (!access.canSee) {
    reply.code(404).send({ error: "room_not_found" });
    return null;
  }
  if (need === "enter" ? !access.canEnter : !access.canRead) {
    reply.code(403).send({ error: "room_forbidden" });
    return null;
  }
  return access;
}

/** A Membership leaving a Server takes its Roles with it, so rejoining restores none. */
export function clearMemberRoles(sqlite: DatabaseSync, serverId: string, userId: string) {
  run(sqlite, "delete from member_roles where server_id = ? and user_id = ?", [serverId, userId]);
}

/** A Membership leaving a Server takes its Channel access with it. */
export function clearRoomGrants(sqlite: DatabaseSync, serverId: string, userId: string) {
  run(sqlite, "delete from room_access where user_id = ? and room_id in (select id from rooms where server_id = ?)", [
    userId,
    serverId
  ]);
}
