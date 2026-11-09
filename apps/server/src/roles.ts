/**
 * A Server's Roles and what they make each member (ADR-0038).
 *
 * The resolver every Server-scoped check asks — does this actor hold this
 * Permission in this Server, and do they outrank the member or Role they act
 * on? — lives in `members.ts` with the other permission guards. These rules
 * are what it answers:
 *
 * - **Permissions add up.** `@everyone` plus every Role a member holds; no Role
 *   takes one away. Administrator implies every other one.
 * - **Rank decides only who manages whom.** It is the position of a member's
 *   highest Role, `@everyone` being 0.
 * - **The Server owner is not a Role.** They hold every Permission and stand one
 *   above the highest Role, so nobody outranks them, and they are never the
 *   subject of a Role action.
 * - **Bots hold nothing** (ADR-0010), whatever a stray row says.
 *
 * This module registers the routes that read the Roles and give or remove
 * them; `app.ts` composes it (ADR-0013).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  maxRolesPerServer,
  roleColors,
  roleNameMaxLength,
  serverPermissions,
  type Permission,
  type RoleSummary,
  type RoomSummary
} from "@voxly/shared";
import { audit } from "./audit.js";
import { isBotUser } from "./bots.js";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";
import {
  authenticatedWriteLimit,
  requireJoinedServer,
  requirePermittedServer,
  userIdParam,
  type RouteContext
} from "./http.js";
import { revokeInvitesCreatedBy } from "./invites.js";
import { baselineRoomReadState } from "./readState.js";
import { roomById } from "./rooms.js";
import {
  activeServerMembership,
  hasPermission,
  memberRoleIds,
  outranks,
  permissionsFor,
  rankOf,
  roomReaderIds,
  serverPresenceUser,
  serverRole,
  serverRoles
} from "./members.js";

/**
 * Whether the actor may give or remove this Role on this member, with every
 * rule from ADR-0038. One answer, so every refusal reads the same to a caller.
 */
export function mayChangeMemberRole(
  sqlite: DatabaseSync,
  serverId: string,
  actorId: string,
  targetId: string,
  role: RoleSummary
) {
  if (!hasPermission(sqlite, serverId, actorId, "manageRoles")) return false;
  if (role.kind === "everyone") return false;
  if (isBotUser(sqlite, targetId)) return false;
  if (!outranks(sqlite, serverId, actorId, targetId)) return false;
  const actorIsOwner = activeServerMembership(sqlite, serverId, actorId)?.role === "owner";
  if (actorIsOwner) return true;
  if (role.kind === "admin") return false;
  return role.position < rankOf(sqlite, serverId, actorId);
}

export const roleIdParam = z.string().uuid();

const roleNameSchema = z.string().trim().min(1).max(roleNameMaxLength);
const roleBodySchema = z
  .object({
    name: roleNameSchema.optional(),
    color: z.enum(roleColors).nullable().optional(),
    separate: z.boolean().optional(),
    permissions: z.array(z.enum(serverPermissions)).optional()
  })
  .strict();

/**
 * Whether the actor may change, reorder or delete this Role: the owner may
 * change any; anyone else only a Role strictly below their own highest, and
 * never Admin (decisions 4 and 5). Manage roles is checked by the caller.
 */
export function mayManageRole(sqlite: DatabaseSync, serverId: string, actorId: string, role: RoleSummary) {
  if (activeServerMembership(sqlite, serverId, actorId)?.role === "owner") return true;
  if (role.kind === "admin") return false;
  return role.position < rankOf(sqlite, serverId, actorId);
}

/** Active members who may create Invites now, so a change can tell who just lost it. */
function inviteCreators(sqlite: DatabaseSync, serverId: string) {
  return new Set(
    all<{ user_id: string }>(
      sqlite,
      "select user_id from server_members where server_id = ? and banned_at is null and removed_at is null",
      [serverId]
    )
      .map((row) => row.user_id)
      .filter((userId) => hasPermission(sqlite, serverId, userId, "createInvites"))
  );
}

/**
 * Losing Create invites through a Role change takes the links already issued
 * with it, exactly as taking the Role away from one member does.
 */
function revokeLostInvites(database: VoxlyDatabase, serverId: string, before: Set<string>, now: string) {
  const after = inviteCreators(database.sqlite, serverId);
  for (const userId of before) {
    if (!after.has(userId)) revokeInvitesCreatedBy(database, serverId, userId, now);
  }
}

/** Positions stay dense, `@everyone` at 0 and Admin on top, so rank compares cleanly. */
function renumberRoles(sqlite: DatabaseSync, serverId: string) {
  const ids = all<{ id: string }>(sqlite, "select id from roles where server_id = ? order by position asc", [serverId]);
  ids.forEach((row, index) => run(sqlite, "update roles set position = ? where id = ?", [index, row.id]));
}

/**
 * Who may read each Private channel of a Server right now, so a Role change
 * can tell who it just let in (ADR-0038, decision 21).
 */
function privateRoomReaders(sqlite: DatabaseSync, serverId: string) {
  const readers = new Map<string, { room: RoomSummary; readers: Set<string> }>();
  for (const { id } of all<{ id: string }>(sqlite, "select id from rooms where server_id = ? and is_private = 1", [
    serverId
  ])) {
    const room = roomById(sqlite, id);
    if (room) readers.set(id, { room, readers: roomReaderIds(sqlite, room) });
  }
  return readers;
}

/** Someone a Role change let into a channel starts it read, as a direct grant does. */
function baselineNewReaders(sqlite: DatabaseSync, before: ReturnType<typeof privateRoomReaders>) {
  for (const [roomId, { room, readers }] of before) {
    const fresh = [...roomReaderIds(sqlite, room)].filter((userId) => !readers.has(userId));
    if (fresh.length > 0) baselineRoomReadState(sqlite, roomId, fresh);
  }
}

function inTransaction<T>(database: VoxlyDatabase, work: () => T): T {
  database.sqlite.exec("begin immediate");
  try {
    const result = work();
    database.sqlite.exec("commit");
    return result;
  } catch (cause) {
    database.sqlite.exec("rollback");
    throw cause;
  }
}

export function registerRoleRoutes(context: RouteContext) {
  const { fastify, database, io, realtime } = context;

  /**
   * Re-apply every Private channel's access after a Role change: losing it
   * through a Role takes effect at once, exactly as losing a direct grant does
   * (voice out, reading sockets off), and every list is refreshed (decision 21).
   */
  function reapplyRoomAccess(serverId: string, rooms: Iterable<string>) {
    for (const roomId of rooms) realtime.revokeRoomAccess(serverId, roomId);
    io.to(`server:${serverId}`).emit("server:roomsChanged", { serverId });
  }

  fastify.get("/api/servers/:serverId/roles", async (request, reply) => {
    const scope = requireJoinedServer(context, request, reply);
    if (!scope) return;
    const { serverId, user } = scope;
    return {
      roles: serverRoles(database.sqlite, serverId),
      permissions: permissionsFor(database.sqlite, serverId, user.id),
      rank: rankOf(database.sqlite, serverId, user.id)
    };
  });

  fastify.post("/api/servers/:serverId/roles", { config: authenticatedWriteLimit }, async (request, reply) => {
    const scope = requirePermittedServer(context, request, reply, "manageRoles");
    if (!scope) return;
    const { user: actor, serverId } = scope;
    const { name } = z.object({ name: roleNameSchema }).strict().parse(request.body);
    const count =
      one<{ count: number }>(database.sqlite, "select count(*) as count from roles where server_id = ?", [serverId])
        ?.count ?? 0;
    if (count >= maxRolesPerServer) return reply.code(409).send({ error: "role_limit_reached" });
    const roleId = crypto.randomUUID();
    const now = new Date().toISOString();
    // A new Role goes just above `@everyone`, below everything else, so whoever
    // made it can manage it.
    inTransaction(database, () => {
      run(database.sqlite, "update roles set position = position + 1 where server_id = ? and position >= 1", [
        serverId
      ]);
      run(
        database.sqlite,
        "insert into roles (id, server_id, name, position, permissions, created_at) values (?, ?, ?, 1, '[]', ?)",
        [roleId, serverId, name, now]
      );
      audit(database, actor.id, "role.created", null, serverId);
    });
    database.save();
    io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
    return reply.code(201).send({ role: serverRole(database.sqlite, serverId, roleId) });
  });

  fastify.put("/api/servers/:serverId/roles/order", { config: authenticatedWriteLimit }, async (request, reply) => {
    const scope = requirePermittedServer(context, request, reply, "manageRoles");
    if (!scope) return;
    const { user: actor, serverId } = scope;
    const { roleIds } = z
      .object({ roleIds: z.array(roleIdParam).max(maxRolesPerServer) })
      .strict()
      .parse(request.body);
    // Admin and `@everyone` never move, so only the Roles between them are named.
    const movable = serverRoles(database.sqlite, serverId).filter((role) => role.kind === null);
    const named = new Set(roleIds);
    if (named.size !== roleIds.length || named.size !== movable.length || movable.some((role) => !named.has(role.id))) {
      return reply.code(400).send({ error: "role_order_invalid" });
    }
    const nextPosition = new Map(roleIds.map((id, index) => [id, roleIds.length - index]));
    // Already in this order: nothing to write, audit or tell anyone.
    if (movable.every((role) => nextPosition.get(role.id) === role.position)) {
      return { roles: serverRoles(database.sqlite, serverId) };
    }
    // Anyone but the owner moves only what is below them: every Role at or
    // above their rank keeps its place, which also keeps the rest below it.
    if (activeServerMembership(database.sqlite, serverId, actor.id)?.role !== "owner") {
      const rank = rankOf(database.sqlite, serverId, actor.id);
      if (movable.some((role) => role.position >= rank && nextPosition.get(role.id) !== role.position)) {
        return reply.code(403).send({ error: "forbidden" });
      }
    }
    inTransaction(database, () => {
      for (const [id, position] of nextPosition) {
        run(database.sqlite, "update roles set position = ? where id = ? and server_id = ?", [position, id, serverId]);
      }
      run(database.sqlite, "update roles set position = ? where server_id = ? and kind = 'admin'", [
        roleIds.length + 1,
        serverId
      ]);
      audit(database, actor.id, "role.reordered", null, serverId);
    });
    database.save();
    io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
    return { roles: serverRoles(database.sqlite, serverId) };
  });

  fastify.patch("/api/servers/:serverId/roles/:roleId", { config: authenticatedWriteLimit }, async (request, reply) => {
    const scope = requirePermittedServer(context, request, reply, "manageRoles", { roleId: roleIdParam });
    if (!scope) return;
    const { user: actor, serverId, roleId } = scope;
    const body = roleBodySchema.parse(request.body ?? {});
    const role = serverRole(database.sqlite, serverId, roleId);
    if (!role) return reply.code(404).send({ error: "role_not_found" });
    if (!mayManageRole(database.sqlite, serverId, actor.id, role)) return reply.code(403).send({ error: "forbidden" });
    // `@everyone` is every Membership, not a group anyone reads by name or colour.
    if (
      role.kind === "everyone" &&
      (body.name !== undefined || body.color !== undefined || body.separate !== undefined)
    ) {
      return reply.code(400).send({ error: "role_field_fixed" });
    }
    // Admin holds Administrator, always (ADR-0038); its other Permissions are moot.
    if (role.kind === "admin" && body.permissions && !body.permissions.includes("administrator")) {
      return reply.code(400).send({ error: "role_field_fixed" });
    }
    const permissions = body.permissions
      ? serverPermissions.filter((permission: Permission) => body.permissions!.includes(permission))
      : undefined;
    // Only the owner switches Administrator, on or off, on any Role (decision 5).
    const isOwner = activeServerMembership(database.sqlite, serverId, actor.id)?.role === "owner";
    if (
      permissions &&
      !isOwner &&
      permissions.includes("administrator") !== role.permissions.includes("administrator")
    ) {
      return reply.code(403).send({ error: "forbidden" });
    }
    // Nobody but the owner switches on a Permission they do not hold
    // themselves: otherwise Manage roles alone could put Manage server on a
    // lower Role its holder already has, or on `@everyone`, and promote them.
    if (permissions && !isOwner) {
      const own = new Set(permissionsFor(database.sqlite, serverId, actor.id));
      if (permissions.some((permission) => !role.permissions.includes(permission) && !own.has(permission))) {
        return reply.code(403).send({ error: "forbidden" });
      }
    }
    // Already as asked: nothing to write, audit or tell anyone.
    const unchanged =
      (body.name === undefined || body.name === role.name) &&
      (body.color === undefined || body.color === role.color) &&
      (body.separate === undefined || body.separate === role.separate) &&
      (permissions === undefined || permissions.join() === role.permissions.join());
    if (unchanged) return { role };
    const now = new Date().toISOString();
    // Only Administrator decides who enters a Private channel; no other
    // Permission changes anyone's access.
    const administratorChanged =
      permissions !== undefined && permissions.includes("administrator") !== role.permissions.includes("administrator");
    const readersBefore = administratorChanged ? privateRoomReaders(database.sqlite, serverId) : null;
    inTransaction(database, () => {
      const before = inviteCreators(database.sqlite, serverId);
      if (body.name !== undefined) run(database.sqlite, "update roles set name = ? where id = ?", [body.name, roleId]);
      if (body.color !== undefined)
        run(database.sqlite, "update roles set color = ? where id = ?", [body.color, roleId]);
      if (body.separate !== undefined) {
        run(database.sqlite, "update roles set separate = ? where id = ?", [body.separate ? 1 : 0, roleId]);
      }
      if (permissions) {
        run(database.sqlite, "update roles set permissions = ? where id = ?", [JSON.stringify(permissions), roleId]);
        revokeLostInvites(database, serverId, before, now);
        // Administrator enters every Private channel, so switching it moves people in or out.
        if (readersBefore) baselineNewReaders(database.sqlite, readersBefore);
      }
      audit(database, actor.id, "role.updated", null, serverId);
    });
    database.save();
    io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
    if (readersBefore) reapplyRoomAccess(serverId, readersBefore.keys());
    return { role: serverRole(database.sqlite, serverId, roleId) };
  });

  fastify.delete(
    "/api/servers/:serverId/roles/:roleId",
    { config: authenticatedWriteLimit },
    async (request, reply) => {
      const scope = requirePermittedServer(context, request, reply, "manageRoles", { roleId: roleIdParam });
      if (!scope) return;
      const { user: actor, serverId, roleId } = scope;
      const role = serverRole(database.sqlite, serverId, roleId);
      if (!role) return reply.code(404).send({ error: "role_not_found" });
      if (!mayManageRole(database.sqlite, serverId, actor.id, role))
        return reply.code(403).send({ error: "forbidden" });
      if (role.kind !== null) return reply.code(409).send({ error: "role_fixed" });
      const holders = all<{ user_id: string }>(database.sqlite, "select user_id from member_roles where role_id = ?", [
        roleId
      ]).map((row) => row.user_id);
      const now = new Date().toISOString();
      const readersBefore = privateRoomReaders(database.sqlite, serverId);
      inTransaction(database, () => {
        const before = inviteCreators(database.sqlite, serverId);
        // Deleting a Role takes it from its members and from every Channel access (decision 7).
        run(database.sqlite, "delete from member_roles where role_id = ?", [roleId]);
        run(database.sqlite, "delete from room_access_roles where role_id = ?", [roleId]);
        run(database.sqlite, "delete from roles where id = ? and server_id = ?", [roleId, serverId]);
        renumberRoles(database.sqlite, serverId);
        revokeLostInvites(database, serverId, before, now);
        audit(database, actor.id, "role.deleted", null, serverId);
      });
      database.save();
      for (const userId of holders) realtime.refreshMemberIdentity(serverId, userId);
      io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
      reapplyRoomAccess(serverId, readersBefore.keys());
      return reply.code(204).send();
    }
  );

  const changeMemberRole = (give: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = requireJoinedServer(context, request, reply, { userId: userIdParam, roleId: roleIdParam });
    if (!scope) return;
    const { user: actor, serverId, userId, roleId } = scope;
    const role = serverRole(database.sqlite, serverId, roleId);
    if (!role) return reply.code(404).send({ error: "role_not_found" });
    if (!activeServerMembership(database.sqlite, serverId, userId)) {
      return reply.code(404).send({ error: "member_not_found" });
    }
    // One generic refusal for every rule — no Permission, `@everyone`, Admin
    // without being the owner, a Role or a member at or above the actor, a Bot
    // — so a caller learns nothing about which line they crossed.
    if (!mayChangeMemberRole(database.sqlite, serverId, actor.id, userId, role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    // Already as asked: nothing to write, audit or tell anyone.
    if (memberRoleIds(database.sqlite, serverId, userId).includes(roleId) === give) {
      const current = serverPresenceUser(database.sqlite, serverId, userId);
      return current ? { user: current } : reply.code(404).send({ error: "member_not_found" });
    }
    const now = new Date().toISOString();
    const readersBefore = privateRoomReaders(database.sqlite, serverId);
    database.sqlite.exec("begin immediate");
    try {
      if (give) {
        run(
          database.sqlite,
          `insert or ignore into member_roles (server_id, user_id, role_id, granted_by_user_id, granted_at)
           values (?, ?, ?, ?, ?)`,
          [serverId, userId, roleId, actor.id, now]
        );
      } else {
        run(database.sqlite, "delete from member_roles where server_id = ? and user_id = ? and role_id = ?", [
          serverId,
          userId,
          roleId
        ]);
        // Losing the right to invite takes the links already issued with it,
        // or they keep admitting people after the owner believes it ended.
        if (!hasPermission(database.sqlite, serverId, userId, "createInvites")) {
          revokeInvitesCreatedBy(database, serverId, userId, now);
        }
      }
      baselineNewReaders(database.sqlite, readersBefore);
      audit(database, actor.id, give ? "role.given" : "role.removed", userId, serverId);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    const updated = realtime.refreshMemberIdentity(serverId, userId);
    io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
    reapplyRoomAccess(serverId, readersBefore.keys());
    if (!updated) return reply.code(404).send({ error: "member_not_found" });
    return { user: updated };
  };

  fastify.put(
    "/api/servers/:serverId/members/:userId/roles/:roleId",
    { config: authenticatedWriteLimit },
    changeMemberRole(true)
  );
  fastify.delete(
    "/api/servers/:serverId/members/:userId/roles/:roleId",
    { config: authenticatedWriteLimit },
    changeMemberRole(false)
  );
}
