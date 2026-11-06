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
import type { RoleSummary } from "@voxly/shared";
import { audit } from "./audit.js";
import { isBotUser } from "./bots.js";
import { run } from "./db/database.js";
import { authenticatedWriteLimit, requireJoinedServer, userIdParam, type RouteContext } from "./http.js";
import { revokeInvitesCreatedBy } from "./invites.js";
import {
  activeServerMembership,
  hasPermission,
  memberRoleIds,
  outranks,
  permissionsFor,
  rankOf,
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

export function registerRoleRoutes(context: RouteContext) {
  const { fastify, database, io, realtime } = context;

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
      audit(database, actor.id, give ? "role.given" : "role.removed", userId, serverId);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    const updated = realtime.refreshMemberIdentity(serverId, userId);
    io.to(`server:${serverId}`).emit("server:rolesChanged", { serverId });
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
