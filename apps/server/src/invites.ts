/**
 * Invites and access links: the two ways a person arrives at a server without
 * already having a session for it, and everything that decides whether a link
 * still admits anyone.
 *
 * They are one module because they are one flow with two credentials. An invite
 * is a bearer token an owner or a delegated inviter mints for whoever they hand
 * it to; an access link is a bearer token an owner mints for one member they
 * name. Both are stored only as hashes, both expire, both are revocable, and
 * both end in the same place: a membership activated and a session set. The
 * rules that keep them safe — a generic answer for every invalid link, capacity
 * counted and consumed inside the transaction that activates the membership —
 * would have to be restated in two modules if they were split.
 *
 * `POST /api/setup/owner/claim` is a different credential despite the name: it
 * is owner recovery, and `auth/ownerClaims.ts` owns it. Nothing here touches it.
 *
 * The `/api/owner/invites` routes live here rather than with the rest of the
 * owner panel because they are these same three operations with `defaultServerId`
 * substituted for a path parameter. Keeping them apart would give the capacity
 * ceiling and the active/inactive distinction two call sites in two modules, and
 * a change to either would have to be made in a file its author was not reading.
 *
 * This module registers its own routes; `app.ts` composes it and hands it a
 * `RouteContext`. See
 * `docs/adr/0013-route-modules-register-their-own-routes.md`.
 */

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit } from "./audit.js";
import {
  authenticateHttp,
  createSession,
  requireOwner,
  requireUser,
  setSessionCookie
} from "./auth/sessions.js";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { rejectBotTarget } from "./bots.js";
import { all, defaultServerId, one, run, type VoxlyDatabase } from "./db/database.js";
import {
  activateServerMembership,
  requireServerInviter,
  serverMembership
} from "./members.js";
import { createUser, nicknameSchema, publicUser, type UserRow } from "./users.js";
import { verifyTurnstile } from "./turnstile.js";
import {
  authenticatedWriteLimit,
  requireOwnedServer,
  serverIdParam,
  unauthenticatedWriteLimit,
  userIdParam,
  type RouteContext
} from "./http.js";

/**
 * Resource ceilings.
 *
 * Voxly targets small private groups, so these are deliberately far above any
 * legitimate use and exist only to stop unbounded growth on a single-file SQLite
 * database. Tune them freely — nothing else depends on the exact values.
 */
const defaultInviteExpiryMinutes = 10080; // 7 days, when the caller omits an expiry
// Comfortably above the 56-entry preset matrix an owner can legitimately create
// (see the invite-preset test), while still bounding growth.
const maxActiveInvitesPerCreator = 200;

/**
 * What an owner may ask for when minting a link.
 *
 * Expiry and capacity are independent nullable limits, and each accepts only
 * its fixed list of values — an arbitrary number is not a compatibility
 * shortcut (`AGENTS.md`, Authentication and Sensitive Tokens).
 */
export const inviteBodySchema = z.object({
  label: z.string().trim().min(1).max(80),
  expiresInMinutes: z.union([z.literal(30), z.literal(60), z.literal(360), z.literal(720), z.literal(1440), z.literal(10080), z.literal(43200), z.null()]).optional(),
  maxUses: z.union([z.literal(1), z.literal(5), z.literal(10), z.literal(25), z.literal(50), z.literal(100), z.null()]).optional()
}).strict();

/** Access links are short-lived by design: a named member's way back in, not a standing credential. */
const accessLinkLifetimeMinutes = 15;

export function registerInviteRoutes(context: RouteContext) {
  const { fastify, database, realtime, secureCookies, turnstile } = context;

  fastify.post("/api/invites/accept", { config: unauthenticatedWriteLimit }, async (request, reply) => {
    const body = z.object({
      inviteToken: z.string().min(24),
      nickname: nicknameSchema.optional(),
      turnstileToken: z.string().optional()
    }).parse(request.body);

    const existingUser = authenticateHttp(database, request, reply, secureCookies);

    if (!existingUser && turnstile?.enabled) {
      const ok = await verifyTurnstile(turnstile.secretKey, body.turnstileToken, turnstile.expectedHostname);
      if (!ok) {
        return reply.code(403).send({ error: "turnstile_failed" });
      }
    }

    if (!existingUser && !body.nickname) {
      return reply.code(400).send({ error: "nickname_required" });
    }

    let user: { id: string; nickname: string; role: "owner" | "member"; bannedAt: string | null } | null = existingUser;
    let serverId = "";
    database.sqlite.exec("begin immediate");
    try {
      const invite = one<{
        id: string;
        server_id: string;
        max_uses: number | null;
        expires_at: string | null;
        revoked_at: string | null;
      }>(
        database.sqlite,
        `select id, server_id, max_uses, expires_at, revoked_at
         from invites where token_hash = ?`,
        [hashToken(body.inviteToken)]
      );
      if (!invite || invite.revoked_at || isExpired(invite.expires_at)) {
        database.sqlite.exec("rollback");
        return reply.code(404).send({ error: "invite_invalid" });
      }

      const member = existingUser ? serverMembership(database.sqlite, invite.server_id, existingUser.id) : null;
      const priorUse = existingUser
        ? one<{ used_at: string }>(database.sqlite, "select used_at from invite_uses where invite_id = ? and user_id = ?", [invite.id, existingUser.id])
        : null;
      if (member?.banned_at) {
        database.sqlite.exec("rollback");
        return reply.code(403).send({ error: "server_banned" });
      }
      if (member && !member.removed_at && priorUse) {
        database.sqlite.exec("rollback");
        return reply.code(409).send({ error: "already_server_member", serverId: invite.server_id });
      }
      if (priorUse) {
        database.sqlite.exec("rollback");
        return reply.code(404).send({ error: "invite_invalid" });
      }

      const usedCount = inviteUseCount(database.sqlite, invite.id);
      if (invite.max_uses !== null && usedCount >= invite.max_uses) {
        database.sqlite.exec("rollback");
        return reply.code(404).send({ error: "invite_invalid" });
      }
      if (member && !member.removed_at) {
        database.sqlite.exec("rollback");
        return reply.code(409).send({ error: "already_server_member", serverId: invite.server_id });
      }

      user = existingUser ?? createUser(database, body.nickname as string, "member");
      const now = new Date().toISOString();
      activateServerMembership(database, invite.server_id, user.id, "member", now);
      run(database.sqlite, "insert into invite_uses (invite_id, user_id, used_at) values (?, ?, ?)", [invite.id, user.id, now]);
      run(
        database.sqlite,
        `update invites
         set used_by_user_id = coalesce(used_by_user_id, ?), used_at = coalesce(used_at, ?)
         where id = ?`,
        [user.id, now, invite.id]
      );
      serverId = invite.server_id;
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    if (!user) throw new Error("invite acceptance completed without a user");
    database.save();
    await realtime.grantServerAccess(serverId, user.id);
    // No Recovery code is minted here.
    //
    // Joining is not the moment to hand somebody a secret to look after: they
    // came to talk to their friends, they will click past it, and a code nobody
    // saved is worse than none because it looks like a safety net. The owner can
    // still issue a fresh invite for anybody who loses everything, so the
    // account is not stranded — and a member who wants the code can make one
    // from settings, where it is offered plainly.
    if (!existingUser) {
      const token = createSession(database, user.id, request.headers["user-agent"]);
      setSessionCookie(reply, token, secureCookies);
    }

    return reply.code(existingUser ? 200 : 201).send({ user: publicUser(user), serverId });
  });

  fastify.post("/api/invites/preview", { config: unauthenticatedWriteLimit }, async (request, reply) => {
    const { inviteToken } = z.object({ inviteToken: z.string().min(24) }).parse(request.body);
    // Joined to the server row rather than a name stored on the invite, so a
    // link minted before a rename still shows what the server is called now.
    const invite = one<{
      server_name: string;
      invite_id: string;
      max_uses: number | null;
      expires_at: string | null;
      revoked_at: string | null;
    }>(
      database.sqlite,
      `select servers.name as server_name, invites.id as invite_id, invites.max_uses,
        invites.expires_at, invites.revoked_at
       from invites
       join servers on servers.id = invites.server_id
       where invites.token_hash = ?`,
      [hashToken(inviteToken)]
    );
    const usedCount = invite ? inviteUseCount(database.sqlite, invite.invite_id) : 0;
    if (!invite || invite.revoked_at || isExpired(invite.expires_at) || (invite.max_uses !== null && usedCount >= invite.max_uses)) {
      return reply.code(404).send({ error: "invite_invalid" });
    }
    return {
      serverName: invite.server_name,
      expiresAt: invite.expires_at,
      remainingUses: invite.max_uses === null ? null : invite.max_uses - usedCount
    };
  });

  fastify.post("/api/servers/:serverId/invites", { config: authenticatedWriteLimit }, async (request, reply) => {
    // Spelled out rather than using a shared preamble: invite creation is the
    // one server-scoped route an ordinary member may reach, through the
    // `can_invite` grant, so it asks `requireServerInviter` rather than
    // membership or ownership.
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { serverId } = z.object({ serverId: serverIdParam }).parse(request.params);
    const membership = requireServerInviter(database, serverId, user.id, reply);
    if (!membership) return;
    const body = inviteBodySchema.parse(request.body ?? {});
    // A never-expiring link is a standing credential. Delegated inviters can add
    // people; handing them a permanent one exceeds what that grant is meant to be.
    if (body.expiresInMinutes === null && membership.role !== "owner") {
      return reply.code(403).send({ error: "invite_expiry_required" });
    }
    if (activeInviteCount(database.sqlite, serverId, user.id) >= maxActiveInvitesPerCreator) {
      return reply.code(409).send({ error: "invite_limit_reached" });
    }
    const invite = createInviteForServer(database, serverId, user.id, body);
    audit(database, user.id, "invite.created", null, serverId);
    database.save();
    return reply.code(201).send({ invite });
  });

  fastify.get("/api/servers/:serverId/invites", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply);
    if (!scope) return;
    return { invites: serverInvites(database.sqlite, scope.serverId) };
  });

  fastify.post("/api/servers/:serverId/invites/:inviteId/revoke", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply, { inviteId: z.string().uuid() });
    if (!scope) return;
    const { owner, serverId, inviteId } = scope;
    const result = revokeServerInvite(database, serverId, inviteId, owner.id);
    if (result === "not_found") return reply.code(404).send({ error: "invite_not_found" });
    if (result === "inactive") return reply.code(409).send({ error: "invite_not_active" });
    return reply.code(204).send();
  });

  fastify.post("/api/servers/:serverId/members/:userId/access-links", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply, { userId: userIdParam });
    if (!scope) return;
    const { owner, serverId, userId } = scope;
    const member = serverMembership(database.sqlite, serverId, userId);
    if (!member || member.removed_at || member.banned_at) return reply.code(404).send({ error: "member_not_found" });
    if (rejectBotTarget(database, userId, reply)) return;
    const token = createOpaqueToken();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + accessLinkLifetimeMinutes * 60 * 1000).toISOString();
    // At most one active link per server/member pair: minting a replacement
    // retires whatever the owner handed out before, so an older message cannot
    // still let someone in. Consumed and revoked rows stay for the audit trail.
    run(
      database.sqlite,
      `update access_claims
       set revoked_at = ?
       where server_id = ?
         and user_id = ?
         and consumed_at is null
         and revoked_at is null
         and expires_at > ?`,
      [nowIso, serverId, userId, nowIso]
    );
    run(
      database.sqlite,
      "insert into access_claims (id, token_hash, user_id, server_id, created_by_user_id, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), hashToken(token), userId, serverId, owner.id, nowIso, expiresAt]
    );
    audit(database, owner.id, "access_link.created", userId, serverId);
    database.save();
    return reply.code(201).send({ token, expiresAt });
  });

  fastify.post("/api/access/claim", { config: unauthenticatedWriteLimit }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(24) }).parse(request.body);
    const claim = one<{ id: string; user_id: string; server_id: string; expires_at: string; consumed_at: string | null; revoked_at: string | null }>(
      database.sqlite,
      "select id, user_id, server_id, expires_at, consumed_at, revoked_at from access_claims where token_hash = ?",
      [hashToken(token)]
    );
    // Unknown, expired, consumed, revoked and orphaned all answer the same way;
    // which one it was is not the caller's to learn.
    if (!claim || claim.consumed_at || claim.revoked_at || isExpired(claim.expires_at)) return reply.code(404).send({ error: "access_claim_invalid" });
    const user = one<UserRow>(database.sqlite, "select id, nickname, role, banned_at from users where id = ?", [claim.user_id]);
    if (!user) return reply.code(404).send({ error: "access_claim_invalid" });
    run(database.sqlite, "update access_claims set consumed_at = ? where id = ?", [new Date().toISOString(), claim.id]);
    audit(database, user.id, "access_link.consumed", user.id);
    const sessionToken = createSession(database, user.id, request.headers["user-agent"]);
    setSessionCookie(reply, sessionToken, secureCookies);
    return reply.code(201).send({
      user: publicUser({ ...user, bannedAt: user.banned_at }),
      serverId: claim.server_id
    });
  });

  fastify.post("/api/owner/invites", { config: authenticatedWriteLimit }, async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }
    if (activeInviteCount(database.sqlite, defaultServerId, owner.id) >= maxActiveInvitesPerCreator) {
      return reply.code(409).send({ error: "invite_limit_reached" });
    }
    const invite = createInviteForServer(database, defaultServerId, owner.id, inviteBodySchema.parse(request.body ?? {}));
    audit(database, owner.id, "invite.created", null, defaultServerId);
    database.save();
    return reply.code(201).send({ invite });
  });

  fastify.get("/api/owner/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }

    return {
      invites: serverInvites(database.sqlite, defaultServerId)
    };
  });

  fastify.post("/api/owner/invites/:inviteId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }
    const { inviteId } = z.object({ inviteId: z.string().uuid() }).parse(request.params);
    const result = revokeServerInvite(database, defaultServerId, inviteId, owner.id);
    if (result === "not_found") return reply.code(404).send({ error: "invite_not_found" });
    if (result === "inactive") return reply.code(409).send({ error: "invite_not_active" });
    return reply.code(204).send();
  });
}

export function createInviteForServer(
  database: VoxlyDatabase,
  serverId: string,
  createdByUserId: string,
  body: z.infer<typeof inviteBodySchema>
) {
  const token = createOpaqueToken();
  const id = crypto.randomUUID();
  const now = new Date();
  // An omitted expiry used to mean "never", which made every such link a
  // permanent account-creation credential — the opposite of how `maxUses`
  // defaults. Omission now means the bounded default; only an explicit `null`
  // from an owner produces a link that never expires.
  const expiresInMinutes = body.expiresInMinutes === undefined
    ? defaultInviteExpiryMinutes
    : body.expiresInMinutes;
  const expiresAt = expiresInMinutes === null
    ? null
    : new Date(now.getTime() + expiresInMinutes * 60 * 1000).toISOString();
  const maxUses = body.maxUses === undefined ? 1 : body.maxUses;
  run(
    database.sqlite,
    `insert into invites
      (id, server_id, token_hash, label, created_by_user_id, expires_at, max_uses, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, serverId, hashToken(token), body.label, createdByUserId, expiresAt, maxUses, now.toISOString()]
  );
  return { id, token, label: body.label, expiresAt, maxUses, usedCount: 0, serverId };
}

export function serverInvites(sqlite: DatabaseSync, serverId: string) {
  return all(
    sqlite,
    `select invites.id, invites.server_id as serverId, coalesce(invites.label, '') as label,
      invites.created_by_user_id as createdByUserId,
      invites.used_by_user_id as usedByUserId, invites.used_at as usedAt,
      invites.expires_at as expiresAt, invites.revoked_at as revokedAt,
      invites.max_uses as maxUses, count(invite_uses.user_id) as usedCount,
      invites.created_at as createdAt
     from invites
     left join invite_uses on invite_uses.invite_id = invites.id
     where invites.server_id = ?
     group by invites.id
     order by invites.created_at desc`,
    [serverId]
  );
}

function revokeServerInvite(database: VoxlyDatabase, serverId: string, inviteId: string, ownerId: string) {
  const invite = one<{ id: string; max_uses: number | null; expires_at: string | null; revoked_at: string | null }>(
    database.sqlite,
    "select id, max_uses, expires_at, revoked_at from invites where id = ? and server_id = ?",
    [inviteId, serverId]
  );
  if (!invite) return "not_found" as const;
  const usedCount = inviteUseCount(database.sqlite, invite.id);
  if (invite.revoked_at || isExpired(invite.expires_at) || (invite.max_uses !== null && usedCount >= invite.max_uses)) {
    return "inactive" as const;
  }
  run(database.sqlite, "update invites set revoked_at = ? where id = ?", [new Date().toISOString(), inviteId]);
  audit(database, ownerId, "invite.revoked", inviteId, serverId);
  database.save();
  return "revoked" as const;
}

/**
 * Revoke the still-active invites a member issued on one server.
 *
 * Called when that member loses access or loses the invite grant — both of
 * which are membership moderation, so `app.ts` calls this back rather than the
 * routes moving here. Already-revoked and already-expired rows are left alone
 * so the audit trail keeps their original timestamps.
 */
export function revokeInvitesCreatedBy(database: VoxlyDatabase, serverId: string, userId: string, now: string) {
  run(
    database.sqlite,
    `update invites
     set revoked_at = ?
     where server_id = ?
       and created_by_user_id = ?
       and revoked_at is null
       and (expires_at is null or expires_at > ?)`,
    [now, serverId, userId, now]
  );
}

/** Invites a member has outstanding on one server: neither revoked nor expired. */
export function activeInviteCount(sqlite: DatabaseSync, serverId: string, createdByUserId: string) {
  return one<{ count: number }>(
    sqlite,
    `select count(*) as count from invites
     where server_id = ? and created_by_user_id = ?
       and revoked_at is null
       and (expires_at is null or expires_at > ?)`,
    [serverId, createdByUserId, new Date().toISOString()]
  )?.count ?? 0;
}

/** One use per account, counted from `invite_uses` rather than the legacy first-use columns. */
export function inviteUseCount(sqlite: DatabaseSync, inviteId: string) {
  return one<{ count: number }>(sqlite, "select count(*) as count from invite_uses where invite_id = ?", [inviteId])?.count ?? 0;
}

/**
 * Whether a nullable deadline has passed. `null` is not a missing value here —
 * it is the deliberate "no limit" half of every nullable limit in this module.
 */
export function isExpired(value: string | null) {
  return value ? new Date(value).getTime() <= Date.now() : false;
}
