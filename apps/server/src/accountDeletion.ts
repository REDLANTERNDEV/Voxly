import { z } from "zod";
import { audit } from "./audit.js";
import { requireOwner,requireUser,revokeSessionsForUser } from "./auth/sessions.js";
import { all,one,run,type VoxlyDatabase } from "./db/database.js";
import { authenticatedWriteLimit,userIdParam,type RouteContext } from "./http.js";

const deletionCooldownMs = 24 * 60 * 60 * 1000;

type DeletionSource = "request_approved" | "owner_initiated";

type DeletableAccount = {
  id: string;
  nickname: string;
  role: "owner" | "member";
  banned_at: string | null;
  is_bot: number;
  deleted_at: string | null;
};

function membershipProjection(database: VoxlyDatabase, userId: string) {
  return all<{
    serverId: string;
    serverName: string;
    nickname: string;
    role: "owner" | "member";
    bannedAt: string | null;
    removedAt: string | null;
  }>(
    database.sqlite,
    `select servers.id as serverId, servers.name as serverName,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role, server_members.banned_at as bannedAt,
      server_members.removed_at as removedAt
     from server_members
     join servers on servers.id = server_members.server_id
     join users on users.id = server_members.user_id
     where server_members.user_id = ?
     order by servers.name asc`,
    [userId]
  ).map((membership) => ({
    serverId: membership.serverId,
    serverName: membership.serverName,
    nickname: membership.nickname,
    role: membership.role,
    state: membership.removedAt ? "removed" as const : membership.bannedAt ? "banned" as const : "active" as const
  }));
}

function accountById(database: VoxlyDatabase, userId: string) {
  return one<DeletableAccount>(
    database.sqlite,
    "select id, nickname, role, banned_at, is_bot, deleted_at from users where id = ?",
    [userId]
  );
}

function deletionRefusal(database: VoxlyDatabase, account: DeletableAccount | null) {
  if (!account) return "account_not_found" as const;
  if (account.deleted_at) return "account_already_deleted" as const;
  if (account.role === "owner") return "account_is_installation_owner" as const;
  if (account.is_bot) return "account_is_bot" as const;
  const ownsServer = one<{ count: number }>(
    database.sqlite,
    "select count(*) as count from server_members where user_id = ? and role = 'owner'",
    [account.id]
  )?.count ?? 0;
  return ownsServer > 0 ? "account_owns_server" as const : null;
}

function deleteAccount(
  database: VoxlyDatabase,
  actorUserId: string,
  userId: string,
  source: DeletionSource,
  requestId?: string
) {
  database.sqlite.exec("begin immediate");
  try {
    const account = accountById(database, userId);
    const refusal = deletionRefusal(database, account);
    if (refusal || !account) {
      database.sqlite.exec("rollback");
      return { ok: false as const, error: refusal ?? "account_not_found" as const };
    }
    const serverIds = all<{ server_id: string }>(database.sqlite, "select server_id from server_members where user_id = ?", [userId])
      .map((membership) => membership.server_id);
    const now = new Date().toISOString();
    run(database.sqlite, "update users set nickname = '', deleted_at = ?, deletion_source = ? where id = ? and deleted_at is null", [now, source, userId]);
    run(database.sqlite, "update server_members set nickname = null, removed_at = ?, can_invite = 0 where user_id = ?", [now, userId]);
    revokeSessionsForUser(database.sqlite, userId, now);
    run(database.sqlite, "delete from session_tokens where session_id in (select id from sessions where user_id = ?)", [userId]);
    run(database.sqlite, "delete from device_links where user_id = ?", [userId]);
    run(database.sqlite, "update recovery_codes set replaced_at = coalesce(replaced_at, ?) where user_id = ?", [now, userId]);
    run(database.sqlite, "update invites set revoked_at = coalesce(revoked_at, ?) where created_by_user_id = ?", [now, userId]);
    run(database.sqlite, "update access_claims set revoked_at = coalesce(revoked_at, ?) where user_id = ? or created_by_user_id = ?", [now, userId, userId]);
    run(database.sqlite, "update owner_claims set consumed_at = coalesce(consumed_at, ?) where user_id = ?", [now, userId]);
    if (requestId) {
      run(
        database.sqlite,
        "update account_deletion_requests set status = 'approved', resolved_at = ?, resolved_by_user_id = ? where id = ? and status = 'pending'",
        [now, actorUserId, requestId]
      );
    } else {
      run(
        database.sqlite,
        "update account_deletion_requests set status = 'approved', resolved_at = ?, resolved_by_user_id = ? where user_id = ? and status = 'pending'",
        [now, actorUserId, userId]
      );
    }
    audit(database, actorUserId, "account.deleted", userId);
    database.sqlite.exec("commit");
    database.save();
    return { ok: true as const, serverIds };
  } catch (error) {
    database.sqlite.exec("rollback");
    throw error;
  }
}

export function registerAccountDeletionRoutes(context: RouteContext) {
  const { fastify,database,realtime,secureCookies,io } = context;

  fastify.get("/api/account/deletion-request", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    return {
      request: one(
        database.sqlite,
        `select id, status, requested_at as requestedAt, resolved_at as resolvedAt
         from account_deletion_requests where user_id = ?
         order by requested_at desc limit 1`,
        [user.id]
      )
    };
  });

  fastify.post("/api/account/deletion-request", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const body = z.object({ nickname: z.string() }).parse(request.body);
    const account = accountById(database, user.id);
    const refusal = deletionRefusal(database, account);
    if (refusal) return reply.code(409).send({ error: refusal });
    if (!account || body.nickname !== account.nickname) return reply.code(400).send({ error: "nickname_confirmation_mismatch" });
    const existing = one<{ status: string; resolved_at: string | null }>(
      database.sqlite,
      "select status, resolved_at from account_deletion_requests where user_id = ? order by requested_at desc limit 1",
      [user.id]
    );
    if (existing?.status === "pending") return reply.code(409).send({ error: "deletion_request_pending" });
    if (existing?.resolved_at && ["cancelled", "rejected"].includes(existing.status)) {
      const retryAt = new Date(existing.resolved_at).getTime() + deletionCooldownMs;
      if (retryAt > Date.now()) return reply.code(429).send({ error: "deletion_request_cooldown", retryAt: new Date(retryAt).toISOString() });
    }
    const deletionRequest = { id: crypto.randomUUID(), requestedAt: new Date().toISOString() };
    run(
      database.sqlite,
      "insert into account_deletion_requests (id, user_id, status, requested_at) values (?, ?, 'pending', ?)",
      [deletionRequest.id, user.id, deletionRequest.requestedAt]
    );
    audit(database, user.id, "account.deletion_requested", user.id);
    database.save();
    for (const socket of io.sockets.sockets.values()) {
      if ((socket.data.user as { role?: string } | undefined)?.role === "owner") {
        socket.emit("account:deletionRequestCreated", { requestId: deletionRequest.id });
      }
    }
    return reply.code(201).send({ request: { ...deletionRequest, status: "pending" } });
  });

  fastify.delete("/api/account/deletion-request", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const now = new Date().toISOString();
    const result = database.sqlite.prepare(
      "update account_deletion_requests set status = 'cancelled', resolved_at = ? where user_id = ? and status = 'pending'"
    ).run(now, user.id);
    if (result.changes === 0) return reply.code(404).send({ error: "deletion_request_not_found" });
    audit(database, user.id, "account.deletion_cancelled", user.id);
    database.save();
    return reply.code(204).send();
  });

  fastify.get("/api/owner/deletion-requests", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const requests = all<{ id: string; userId: string; nickname: string; bannedAt: string | null; requestedAt: string }>(
      database.sqlite,
      `select account_deletion_requests.id, users.id as userId, users.nickname,
        users.banned_at as bannedAt, account_deletion_requests.requested_at as requestedAt
       from account_deletion_requests join users on users.id = account_deletion_requests.user_id
       where account_deletion_requests.status = 'pending'
       order by account_deletion_requests.requested_at asc`
    );
    return {
      requests: requests.map((item) => ({
        ...item,
        status: item.bannedAt ? "banned" : "active",
        memberships: membershipProjection(database, item.userId)
      }))
    };
  });

  fastify.post("/api/owner/deletion-requests/:requestId/reject", { config: authenticatedWriteLimit }, async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const now = new Date().toISOString();
    const result = database.sqlite.prepare(
      "update account_deletion_requests set status = 'rejected', resolved_at = ?, resolved_by_user_id = ? where id = ? and status = 'pending'"
    ).run(now, owner.id, requestId);
    if (result.changes === 0) return reply.code(404).send({ error: "deletion_request_not_found" });
    audit(database, owner.id, "account.deletion_rejected", requestId);
    database.save();
    return reply.code(204).send();
  });

  fastify.post("/api/owner/deletion-requests/:requestId/approve", { config: authenticatedWriteLimit }, async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const pending = one<{ user_id: string }>(database.sqlite, "select user_id from account_deletion_requests where id = ? and status = 'pending'", [requestId]);
    if (!pending) return reply.code(404).send({ error: "deletion_request_not_found" });
    const result = deleteAccount(database, owner.id, pending.user_id, "request_approved", requestId);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    for (const serverId of result.serverIds) {
      io.to(`server:${serverId}`).emit("server:memberDeleted", { serverId, userId: pending.user_id });
      io.to(`server:${serverId}`).emit("server:directoryChanged", { serverId });
    }
    realtime.terminateAccount(pending.user_id, "request_approved");
    return reply.code(204).send();
  });

  fastify.get("/api/owner/accounts", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { query } = z.object({ query: z.string().trim().max(64).default("") }).parse(request.query ?? {});
    return {
      accounts: all<{
        id: string;
        nickname: string;
        role: "owner" | "member";
        bannedAt: string | null;
        isBot: number;
        deletedAt: string | null;
        serverCount: number;
      }>(
        database.sqlite,
        `select users.id, users.nickname, users.role, users.banned_at as bannedAt,
          users.is_bot as isBot, users.deleted_at as deletedAt,
          count(server_members.server_id) as serverCount
         from users left join server_members on server_members.user_id = users.id
         where (? = '' or users.nickname like '%' || ? || '%')
         group by users.id order by users.nickname asc`,
        [query, query]
      ).map((account) => ({ ...account, isBot: Boolean(account.isBot) }))
    };
  });

  fastify.get("/api/owner/accounts/:userId", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { userId } = z.object({ userId: userIdParam }).parse(request.params);
    const account = accountById(database, userId);
    if (!account) return reply.code(404).send({ error: "account_not_found" });
    const memberships = membershipProjection(database, userId);
    return {
      account: {
        id: account.id,
        nickname: account.nickname,
        role: account.role,
        bannedAt: account.banned_at,
        isBot: Boolean(account.is_bot),
        deletedAt: account.deleted_at,
        serverCount: memberships.length,
        memberships
      }
    };
  });

  fastify.delete("/api/owner/accounts/:userId", { config: authenticatedWriteLimit }, async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { userId } = z.object({ userId: userIdParam }).parse(request.params);
    const body = z.object({ nickname: z.string(), permanent: z.literal(true) }).parse(request.body);
    const account = accountById(database, userId);
    const refusal = deletionRefusal(database, account);
    if (refusal) return reply.code(409).send({ error: refusal });
    if (!account || body.nickname !== account.nickname) return reply.code(400).send({ error: "nickname_confirmation_mismatch" });
    const pending = one<{ id: string }>(database.sqlite, "select id from account_deletion_requests where user_id = ? and status = 'pending'", [userId]);
    const source: DeletionSource = pending ? "request_approved" : "owner_initiated";
    const result = deleteAccount(database, owner.id, userId, source, pending?.id);
    if (!result.ok) return reply.code(409).send({ error: result.error });
    for (const serverId of result.serverIds) {
      io.to(`server:${serverId}`).emit("server:memberDeleted", { serverId, userId });
      io.to(`server:${serverId}`).emit("server:directoryChanged", { serverId });
    }
    realtime.terminateAccount(userId, source);
    return reply.code(204).send();
  });
}
