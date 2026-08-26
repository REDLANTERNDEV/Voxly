import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Server } from "socket.io";
import { z } from "zod";
import { replyExcerptMaxLength } from "@voxly/shared";
import type {
  ChatMessage,
  ClientToServerEvents,
  PresenceUser,
  ServerToClientEvents
} from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import type { AnalyticsConfig } from "./analytics.js";
import { audit } from "./audit.js";
import {
  allSessions,
  authenticateHttp,
  authenticateSocket,
  authenticateWithoutRenewal,
  clearSessionCookie,
  createSession,
  requireOwner,
  requireUser,
  revokeSession,
  revokeSessionsForUser,
  sessionCookieName,
  setSessionCookie
} from "./auth/sessions.js";
import {
  bearerToken,
  isBotTokenValid,
  issueBotSession,
  musicBotAccounts,
  rejectBotTarget,
  seedMusicBots,
  type BotConfig
} from "./bots.js";
import { helmetOptions } from "./security.js";
import { consumeOwnerClaim } from "./auth/ownerClaims.js";
import { all, defaultServerId, dumpTables, one, openDatabase, run, type VoxlyDatabase } from "./db/database.js";
import {
  activateServerMembership,
  activeServerIds,
  hasActiveServerMembership,
  isServerOwner,
  mayCreateInvites,
  presenceStatusOf,
  publicPresence,
  requireServerMember,
  requireServerOwner,
  serverMembership,
  serverPresenceUser,
  serverPresenceUserIncludingBanned,
  serverPresenceUsers,
  type OnlineRegistry
} from "./members.js";
import { roomById } from "./rooms.js";
import {
  messageLimit,
  requireJoinedServer,
  requireOwnedServer,
  roomIdParam,
  serverIdParam,
  unauthenticatedWriteLimit,
  userIdParam,
  type RealtimeModeration,
  type RouteContext
} from "./http.js";
import { registerInviteRoutes, revokeInvitesCreatedBy } from "./invites.js";
import { registerServerRoutes } from "./servers.js";
import { createUser, nicknameSchema, publicUser } from "./users.js";
import { roomIdPayloadSchema, safeSocketHandler, socketsForUser } from "./socket.js";
import { createMusicRealtime } from "./music.js";
import { createVoiceRealtime } from "./voice.js";
import type { TurnstileConfig } from "./turnstile.js";
import type { RtcConfigProvider } from "./rtcConfig.js";

export interface CreateVoxlyAppOptions {
  databasePath: string;
  publicUrl?: string;
  ownerBootstrapToken?: string;
  allowHttpOwnerBootstrap?: boolean;
  secureCookies: boolean;
  rtc?: RtcConfigProvider;
  turnstile?: TurnstileConfig;
  /**
   * The credential the Music bot process presents to obtain its sessions. Left
   * unset the exchange endpoint is never registered, and the bot accounts sit in
   * their servers offline.
   */
  bot?: BotConfig;
  /** Optional landing-page analytics chosen by the operator. */
  analytics?: AnalyticsConfig;
  webDistPath?: string;
  /** Derive client IPs from X-Forwarded-For. Defaults to true; see below. */
  trustProxy?: boolean;
  /**
   * Request and error logging. Off by default so tests stay quiet; `main.ts`
   * enables it, because a silent process gives operators no way to diagnose a
   * 500 or a crash.
   */
  logger?: boolean;
}

export interface VoxlyApp {
  server: FastifyInstance;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  sqlite: DatabaseSync;
  dumpTables: () => Record<string, unknown>;
  close: () => Promise<void>;
}

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

type MessageRow = {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  suppressedEmbedKeysJson: string | null;
  replyToMessageId: string | null;
  replyToUserId: string | null;
  replyToNickname: string | null;
  replyToBody: string | null;
};

/** Fastify attaches `statusCode` to framework errors; anything without one is a fault. */
function errorStatusCode(error: unknown) {
  const candidate = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === "number" ? candidate : 500;
}

const voiceModerationBodySchema = z.object({
  muted: z.boolean().optional(),
  deafened: z.boolean().optional()
}).strict().refine((body) => body.muted !== undefined || body.deafened !== undefined);

export async function createVoxlyApp(options: CreateVoxlyAppOptions): Promise<VoxlyApp> {
  const database = await openDatabase(options.databasePath);
  seedMusicBots(database);
  const server = Fastify({
    logger: options.logger ?? false,
    // Every supported Voxly topology terminates TLS in a reverse proxy, so the
    // socket address is always the proxy's. Without this, per-IP rate limits
    // would collapse into a single shared bucket and one abusive client would
    // lock out everyone. Operators who expose the app directly should set
    // TRUST_PROXY=false so a spoofed X-Forwarded-For cannot forge identities.
    trustProxy: options.trustProxy ?? true
  });
  await server.register(helmet, helmetOptions({ https: options.secureCookies, analytics: options.analytics }));
  await server.register(rateLimit, {
    // Opt in per route rather than throttling reads and WebSocket polling.
    global: false
  });
  await server.register(cookie);
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: "bad_request" });
      return;
    }
    // Framework-generated client errors carry their own status and a safe,
    // non-revealing message — rate limiting (429), unsupported media type (415),
    // and malformed JSON (400) all arrive this way and must keep their shape.
    if (errorStatusCode(error) < 500) {
      throw error;
    }
    // Anything else is an internal fault. Fastify's default handler would return
    // `error.message` verbatim, which leaks SQLite constraint and column names to
    // the caller; the operator needs that detail instead.
    request.log.error({ err: error }, "unhandled route error");
    reply.code(500).send({ error: "internal_error" });
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server.server, {
    serveClient: false
  });

  const realtime = registerRealtime(io, database);
  // What a route group is handed, and deliberately nothing more; `http.ts` says
  // why each field is here.
  const context: RouteContext = {
    fastify: server,
    database,
    io,
    realtime,
    secureCookies: options.secureCookies,
    turnstile: options.turnstile
  };
  registerRoutes(options, context);
  // Route groups that own their own rules register themselves against the same
  // Fastify instance; see `http.ts` for what they are handed and why.
  registerServerRoutes(context);
  registerInviteRoutes(context);
  if (options.webDistPath) {
    await registerWebStatic(server, options.webDistPath);
  }

  return {
    server,
    io,
    sqlite: database.sqlite,
    dumpTables: () => dumpTables(database.sqlite),
    async close() {
      await io.close();
      await server.close();
      database.close();
    }
  };
}

async function registerWebStatic(server: FastifyInstance, webDistPath: string) {
  await server.register(staticPlugin, {
    root: webDistPath,
    prefix: "/"
  });

  server.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/") || request.url.startsWith("/socket.io/")) {
      reply.code(404).send({ error: "not_found" });
      return;
    }

    reply.sendFile("index.html");
  });
}

/**
 * The routes no domain module owns yet: health and config, the session
 * endpoints, the member directory, membership moderation, messages, and the
 * owner panel.
 *
 * Takes the same `RouteContext` the extracted modules are handed rather than
 * the pieces of it, so there is no way for the handshake these routes use and
 * the one `servers.ts` and `invites.ts` use to drift apart.
 */
function registerRoutes(options: CreateVoxlyAppOptions, context: RouteContext) {
  const { fastify: server, database, io, realtime } = context;
  server.get("/api/health", async () => {
    // Deliberately unauthenticated and dependency-checking: container and load
    // balancer probes need a signal that the process can still reach SQLite,
    // not merely that the event loop is alive.
    one<{ ok: number }>(database.sqlite, "select 1 as ok");
    return { status: "ok" };
  });

  server.get("/api/config", async () => {
    return {
      publicUrl: normalizePublicUrl(options.publicUrl),
      turnstile: options.turnstile ? { siteKey: options.turnstile.siteKey } : null,
      // Public by definition: the browser has to load this script itself.
      analytics: options.analytics
        ? {
            provider: options.analytics.provider,
            scriptUrl: options.analytics.scriptUrl,
            websiteId: options.analytics.websiteId,
            ...(options.analytics.hostUrl ? { hostUrl: options.analytics.hostUrl } : {})
          }
        : null
    };
  });

  server.get("/api/rtc/config", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) return;
    return options.rtc?.getUserConfig(user.id) ?? { iceServers: [], expiresAt: null };
  });

  server.get("/api/me", async (request, reply) => {
    const user = authenticateHttp(database, request, reply, options.secureCookies);
    if (!user) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    return { user: publicUser(user) };
  });

  if (options.allowHttpOwnerBootstrap && options.ownerBootstrapToken) {
    server.post("/api/bootstrap/owner", { config: unauthenticatedWriteLimit }, async (request, reply) => {
      const body = z.object({
        bootstrapToken: z.string().min(1),
        nickname: nicknameSchema
      }).parse(request.body);

      if (body.bootstrapToken !== options.ownerBootstrapToken) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const ownerCount = one<{ count: number }>(
        database.sqlite,
        "select count(*) as count from users where role = 'owner'"
      )?.count ?? 0;
      if (ownerCount > 0) {
        return reply.code(409).send({ error: "owner_exists" });
      }

      const user = createUser(database, body.nickname, "owner");
      activateServerMembership(database, defaultServerId, user.id, "owner", new Date().toISOString());
      const token = createSession(database, user.id);
      setSessionCookie(reply, token, options.secureCookies);

      return reply.code(201).send({ user: publicUser(user) });
    });
  }

  const botConfig = options.bot;
  if (botConfig) {
    /**
     * The Music bot's way in. It holds the operator's credential, not a session,
     * and trades it for one ordinary session per bot account — after which it is
     * an ordinary member and every existing authorization check applies to it
     * unchanged.
     *
     * Returning every account at once is what lets one bot process serve servers
     * created after it started: it re-runs this on each reconnect and picks up
     * whatever exists then.
     */
    server.post("/api/bot/sessions", { config: unauthenticatedWriteLimit }, async (request, reply) => {
      if (!isBotTokenValid(botConfig.token, bearerToken(request.headers.authorization))) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const sessions = musicBotAccounts(database.sqlite).map((account) => {
        const session = issueBotSession(database, account.userId);
        return {
          serverId: account.serverId,
          userId: account.userId,
          nickname: account.nickname,
          token: session.token,
          expiresAt: session.expiresAt
        };
      });
      // The cookie name is the server's to choose, and the bot is not a browser
      // that was told one at sign-in. Naming it here keeps the two from drifting.
      return reply.code(201).send({ cookieName: sessionCookieName, sessions });
    });
  }

  server.post("/api/setup/owner/claim", { config: unauthenticatedWriteLimit }, async (request, reply) => {
    const body = z.object({
      claimToken: z.string().min(24)
    }).parse(request.body);

    const user = consumeOwnerClaim(database, body.claimToken);
    if (!user) {
      return reply.code(404).send({ error: "owner_claim_invalid" });
    }

    const token = createSession(database, user.id);
    setSessionCookie(reply, token, options.secureCookies);

    return reply.code(201).send({ user: publicUser(user) });
  });

  server.post("/api/logout", async (request, reply) => {
    const user = authenticateWithoutRenewal(database.sqlite, request);
    if (user) {
      revokeSession(database.sqlite, user.sessionId);
      database.save();
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  server.get("/api/servers/:serverId/directory", async (request, reply) => {
    const scope = requireJoinedServer(context, request, reply);
    if (!scope) return;
    const { serverId } = scope;
    const members = all<{ userId: string; nickname: string; role: "owner" | "member"; canInvite: number; isBot: number }>(
      database.sqlite,
      `select users.id as userId,
        coalesce(server_members.nickname, users.nickname) as nickname,
        server_members.role,
        server_members.can_invite as canInvite,
        users.is_bot as isBot
       from server_members
       join users on users.id = server_members.user_id
       where server_members.server_id = ?
         and server_members.banned_at is null
         and server_members.removed_at is null
       order by nickname asc`,
      [serverId]
    );
    return {
      members: members.map((member) => ({
        ...member,
        canInvite: Boolean(member.canInvite),
        isBot: Boolean(member.isBot)
      }))
    };
  });

  server.get("/api/servers/:serverId/members", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply);
    if (!scope) return;
    const { serverId } = scope;
    const members = all<{
      id: string;
      nickname: string;
      role: "owner" | "member";
      bannedAt: string | null;
      removedAt: string | null;
      joinedAt: string;
      moderatorMuted: number;
      moderatorDeafened: number;
      canInvite: number;
      isBot: number;
    }>(
      database.sqlite,
      `select users.id,
        coalesce(server_members.nickname, users.nickname) as nickname,
        server_members.role,
        server_members.banned_at as bannedAt, server_members.removed_at as removedAt,
        server_members.joined_at as joinedAt,
        server_members.moderator_muted as moderatorMuted,
        server_members.moderator_deafened as moderatorDeafened,
        server_members.can_invite as canInvite,
        users.is_bot as isBot
       from server_members
       join users on users.id = server_members.user_id
       where server_members.server_id = ?
         and server_members.removed_at is null
       order by nickname asc`,
      [serverId]
    );
    return {
      members: members.map(({ moderatorMuted, moderatorDeafened, canInvite, isBot, ...member }) => ({
        ...member,
        canInvite: mayCreateInvites(member.role, canInvite),
        isBot: Boolean(isBot),
        moderation: { muted: Boolean(moderatorMuted), deafened: Boolean(moderatorDeafened) }
      }))
    };
  });

  server.patch("/api/servers/:serverId/members/:userId/permissions", async (request, reply) => {
    // Spelled out rather than using `requireOwnedServer`: this route answers a
    // malformed body before it answers a caller who does not own the server,
    // and which of the two a client sees is observable.
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, userId } = z.object({ serverId: serverIdParam, userId: userIdParam }).parse(request.params);
    const { canInvite } = z.object({ canInvite: z.boolean() }).strict().parse(request.body);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const target = serverMembership(database.sqlite, serverId, userId);
    if (!target || target.removed_at) {
      return reply.code(404).send({ error: "member_not_found" });
    }
    // Owners already hold every permission; storing a grant for them would let a
    // later revoke read as if it removed something.
    if (target.role === "owner") {
      return reply.code(409).send({ error: "cannot_change_owner_permissions" });
    }
    if (rejectBotTarget(database, userId, reply)) return;
    database.sqlite.exec("begin immediate");
    try {
      run(
        database.sqlite,
        "update server_members set can_invite = ? where server_id = ? and user_id = ?",
        [canInvite ? 1 : 0, serverId, userId]
      );
      // Revoking the grant has to take its products with it, or the links the
      // member already issued keep admitting people after the owner believes the
      // delegation ended.
      if (!canInvite) {
        revokeInvitesCreatedBy(database, serverId, userId, new Date().toISOString());
      }
      audit(database, owner.id, canInvite ? "member.invite_granted" : "member.invite_revoked", userId, serverId);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    const updated = realtime.refreshMemberIdentity(serverId, userId);
    if (!updated) return reply.code(404).send({ error: "member_not_found" });
    return { user: updated };
  });

  server.patch("/api/servers/:serverId/members/:userId/nickname", async (request, reply) => {
    // Spelled out rather than using `requireOwnedServer`: this route answers a
    // malformed body before it answers a caller who does not own the server,
    // and which of the two a client sees is observable.
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, userId } = z.object({ serverId: serverIdParam, userId: userIdParam }).parse(request.params);
    const { nickname } = z.object({ nickname: nicknameSchema }).parse(request.body);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const target = serverMembership(database.sqlite, serverId, userId);
    if (!target || target.removed_at) {
      return reply.code(404).send({ error: "member_not_found" });
    }
    if (target.role === "owner" && userId !== owner.id) {
      return reply.code(409).send({ error: "cannot_rename_owner" });
    }
    run(
      database.sqlite,
      "update server_members set nickname = ? where server_id = ? and user_id = ?",
      [nickname, serverId, userId]
    );
    audit(database, owner.id, "member.nickname_updated", userId, serverId);
    database.save();
    const updated = realtime.refreshMemberIdentity(serverId, userId);
    if (!updated) return reply.code(404).send({ error: "member_not_found" });
    return { user: updated };
  });

  server.patch("/api/servers/:serverId/members/:userId/voice-moderation", async (request, reply) => {
    // Spelled out rather than using `requireOwnedServer`: this route answers a
    // malformed body before it answers a caller who does not own the server,
    // and which of the two a client sees is observable.
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, userId } = z.object({ serverId: serverIdParam, userId: userIdParam }).parse(request.params);
    const body = voiceModerationBodySchema.parse(request.body ?? {});
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const target = serverMembership(database.sqlite, serverId, userId);
    if (!target || target.removed_at) return reply.code(404).send({ error: "member_not_found" });
    if (userId === owner.id || target.role === "owner") {
      return reply.code(409).send({ error: "cannot_moderate_owner" });
    }

    const moderation = {
      muted: body.muted ?? Boolean(target.moderator_muted),
      deafened: body.deafened ?? Boolean(target.moderator_deafened)
    };
    run(
      database.sqlite,
      `update server_members
       set moderator_muted = ?, moderator_deafened = ?
       where server_id = ? and user_id = ?`,
      [moderation.muted ? 1 : 0, moderation.deafened ? 1 : 0, serverId, userId]
    );
    audit(database, owner.id, "member.voice_moderation_updated", userId, serverId);
    database.save();
    realtime.updateVoiceModeration(serverId, userId, moderation);
    io.to(`server:${serverId}`).emit("server:directoryChanged", { serverId });
    return { moderation };
  });

  server.post("/api/servers/:serverId/members/:userId/:action", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply, {
      userId: userIdParam,
      action: z.enum(["ban", "unban", "kick"])
    });
    if (!scope) return;
    const { owner, serverId, userId, action } = scope;
    if (userId === owner.id) return reply.code(409).send({ error: "cannot_moderate_owner" });
    const member = serverMembership(database.sqlite, serverId, userId);
    if (!member) return reply.code(404).send({ error: "member_not_found" });
    if (rejectBotTarget(database, userId, reply)) return;
    const now = new Date().toISOString();
    // Losing access also drops the invite grant, so a member who returns through
    // a later invite cannot silently resume issuing links.
    //
    // Dropping the grant is not enough on its own: invites are bearer tokens with
    // no tie to their creator's standing, so any link the member already minted
    // stays usable. A kicked member could replay one to clear their own
    // `removed_at`, and a banned one could replay it under a fresh nickname —
    // the ban binds to a user id, and identities are free. Revoking what they
    // issued closes both paths, in one transaction with the membership change so
    // the two can never diverge.
    database.sqlite.exec("begin immediate");
    try {
      if (action === "ban") {
        run(database.sqlite, "update server_members set banned_at = ?, removed_at = null, can_invite = 0 where server_id = ? and user_id = ?", [now, serverId, userId]);
      } else if (action === "unban") {
        run(database.sqlite, "update server_members set banned_at = null where server_id = ? and user_id = ?", [serverId, userId]);
      } else {
        run(database.sqlite, "update server_members set removed_at = ?, can_invite = 0 where server_id = ? and user_id = ?", [now, serverId, userId]);
      }
      if (action === "ban" || action === "kick") {
        revokeInvitesCreatedBy(database, serverId, userId, now);
      }
      audit(database, owner.id, `member.${action}`, userId, serverId);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    if (action === "ban" || action === "kick") {
      realtime.revokeServerAccess(serverId, userId, action === "ban" ? "banned" : "kicked");
    }
    io.to(`server:${serverId}`).emit("server:directoryChanged", { serverId });
    return reply.code(204).send();
  });

  server.post("/api/servers/:serverId/voice/:roomId/members/:userId/disconnect", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply, { roomId: roomIdParam, userId: userIdParam });
    if (!scope) return;
    const { owner, serverId, roomId, userId } = scope;
    const room = roomById(database.sqlite, roomId);
    if (!room || room.serverId !== serverId || room.kind !== "voice") return reply.code(404).send({ error: "room_not_found" });
    if (!realtime.disconnectVoice(serverId, roomId, userId)) return reply.code(409).send({ error: "member_not_in_voice" });
    audit(database, owner.id, "voice.disconnected", userId, serverId);
    database.save();
    return reply.code(204).send();
  });

  server.post("/api/servers/:serverId/voice/members/:userId/move", async (request, reply) => {
    const scope = requireOwnedServer(context, request, reply, { userId: userIdParam });
    if (!scope) return;
    const { owner, serverId, userId } = scope;
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    // Scoped to this server, so a move can never place a member in a room they
    // have no membership for.
    if (!room || room.serverId !== serverId || room.kind !== "voice") {
      return reply.code(404).send({ error: "room_not_found" });
    }
    // Whatever room is named. A move is an instruction the *client* carries out
    // by joining, and the Music bot has no client to carry it out with — but
    // that is the small reason. The large one is that neither half of a move
    // means anything for it: arriving would put it in a room nobody in that
    // room summoned it into, and leaving would destroy a Queue from a control
    // that says nothing about destroying one. ADR-0010.
    if (rejectBotTarget(database, userId, reply)) return;
    if (!realtime.moveVoice(serverId, userId, roomId)) {
      return reply.code(409).send({ error: "member_not_in_voice" });
    }
    audit(database, owner.id, "voice.moved", userId, serverId);
    database.save();
    return reply.code(204).send();
  });

  server.get("/api/owner/users", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }

    return {
      users: all(
        database.sqlite,
        `select users.id,
          coalesce(server_members.nickname, users.nickname) as nickname,
          server_members.role,
          server_members.banned_at as bannedAt
         from server_members join users on users.id = server_members.user_id
         where server_members.server_id = ? and server_members.removed_at is null
         order by nickname asc`,
        [defaultServerId]
      )
    };
  });

  server.get("/api/owner/sessions", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }

    return {
      sessions: allSessions(database.sqlite)
    };
  });

  server.get("/api/rooms/:roomId/messages", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "text") {
      return reply.code(404).send({ error: "room_not_found" });
    }
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    const { limit } = z.object({
      limit: z.coerce.number().int().positive().max(200).default(100)
    }).parse(request.query ?? {});

    const messages = all<MessageRow>(
        database.sqlite,
        `select messages.id, messages.room_id as roomId, messages.user_id as userId,
          coalesce(server_members.nickname, users.nickname) as nickname,
          messages.body, messages.created_at as createdAt,
          messages.edited_at as editedAt,
          messages.suppressed_embed_keys as suppressedEmbedKeysJson,
          messages.reply_to_message_id as replyToMessageId,
          ${replyJoinColumns}
         from messages
         join rooms on rooms.id = messages.room_id
         join server_members
           on server_members.server_id = rooms.server_id
          and server_members.user_id = messages.user_id
         join users on users.id = messages.user_id
         ${replyJoinClause}
         where messages.room_id = ?
          and messages.deleted_at is null
         order by messages.created_at desc, messages.rowid desc
         limit ?`,
        [roomId, limit]
      ).reverse().map(publicMessage);

    return {
      messages
    };
  });

  server.post("/api/rooms/:roomId/messages", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    const body = z.object({
      body: z.string().trim().min(1).max(2000),
      replyToMessageId: z.string().min(1).max(64).optional()
    }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    if (!room) {
      return reply.code(404).send({ error: "room_not_found" });
    }
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    if (room.kind !== "text") {
      return reply.code(400).send({ error: "messages_require_text_room" });
    }

    // Scoped to this room, so a reply can never quote a message the author
    // could not otherwise read.
    const replyTarget = body.replyToMessageId
      ? messageById(database.sqlite, roomId, body.replyToMessageId)
      : null;
    if (body.replyToMessageId && !replyTarget) {
      return reply.code(404).send({ error: "reply_target_not_found" });
    }

    const sender = serverPresenceUser(database.sqlite, room.serverId, user.id);
    if (!sender) return reply.code(403).send({ error: "server_forbidden" });
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      roomId,
      userId: user.id,
      nickname: sender.nickname,
      body: body.body,
      createdAt: new Date().toISOString(),
      editedAt: null,
      suppressedEmbedKeys: [],
      replyToMessageId: replyTarget?.id ?? null,
      replyTo: replyTarget
        ? {
          messageId: replyTarget.id,
          userId: replyTarget.userId,
          nickname: replyTarget.nickname,
          body: replyExcerpt(replyTarget.body)
        }
        : null
    };

    run(
      database.sqlite,
      "insert into messages (id, room_id, user_id, body, created_at, reply_to_message_id) values (?, ?, ?, ?, ?, ?)",
      [message.id, message.roomId, message.userId, message.body, message.createdAt, message.replyToMessageId]
    );
    database.save();
    // Every active server member needs the lightweight notification so clients
    // can maintain unread counts for text rooms they have not opened yet.
    io.to(`server:${room.serverId}`).emit("message:new", message);

    return reply.code(201).send({ message });
  });

  server.patch("/api/rooms/:roomId/messages/:messageId", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = z.object({
      roomId: roomIdParam,
      messageId: z.string().uuid()
    }).parse(request.params);
    const body = z.object({ body: z.string().trim().min(1).max(2000) }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "text") {
      return reply.code(404).send({ error: "room_not_found" });
    }
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) {
      return reply.code(404).send({ error: "message_not_found" });
    }
    if (current.userId !== user.id) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const editedAt = new Date().toISOString();
    run(database.sqlite, "update messages set body = ?, edited_at = ? where id = ?", [
      body.body,
      editedAt,
      messageId
    ]);
    database.save();
    const message = messageById(database.sqlite, roomId, messageId);
    if (!message) {
      return reply.code(404).send({ error: "message_not_found" });
    }
    io.to(`room:${roomId}`).emit("message:updated", message);
    return { message };
  });

  server.patch("/api/rooms/:roomId/messages/:messageId/embeds", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) return;
    const { roomId, messageId } = z.object({
      roomId: roomIdParam,
      messageId: z.string().uuid()
    }).parse(request.params);
    const { embedKey } = z.object({
      embedKey: z.string().min(3).max(160).regex(/^(youtube|x|vimeo|spotify):[A-Za-z0-9:_-]+$/u)
    }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "text") return reply.code(404).send({ error: "room_not_found" });
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) return reply.code(404).send({ error: "message_not_found" });
    if (current.userId !== user.id && !isServerOwner(database.sqlite, room.serverId, user.id)) {
      return reply.code(403).send({ error: "forbidden" });
    }

    if (!current.suppressedEmbedKeys.includes(embedKey)) {
      if (current.suppressedEmbedKeys.length >= 16) {
        return reply.code(409).send({ error: "embed_suppression_limit" });
      }
      run(database.sqlite, "update messages set suppressed_embed_keys = ? where id = ?", [
        JSON.stringify([...current.suppressedEmbedKeys, embedKey]),
        messageId
      ]);
      database.save();
    }
    const message = messageById(database.sqlite, roomId, messageId);
    if (!message) return reply.code(404).send({ error: "message_not_found" });
    io.to(`room:${roomId}`).emit("message:updated", message);
    return { message };
  });

  server.delete("/api/rooms/:roomId/messages/:messageId", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = z.object({
      roomId: roomIdParam,
      messageId: z.string().uuid()
    }).parse(request.params);
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "text") {
      return reply.code(404).send({ error: "room_not_found" });
    }
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) {
      return reply.code(404).send({ error: "message_not_found" });
    }
    if (current.userId !== user.id && !isServerOwner(database.sqlite, room.serverId, user.id)) {
      return reply.code(403).send({ error: "forbidden" });
    }

    run(database.sqlite, "update messages set deleted_at = ?, deleted_by_user_id = ? where id = ?", [
      new Date().toISOString(),
      user.id,
      messageId
    ]);
    database.save();
    io.to(`room:${roomId}`).emit("message:deleted", { roomId, messageId });
    return reply.code(204).send();
  });

  server.post("/api/owner/users/:userId/ban", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const { userId } = z.object({ userId: userIdParam }).parse(request.params);
    // A global ban has no undo — the only unban clears a server membership, not
    // `users.banned_at` — and seeding will not replace an account whose
    // membership row still exists. Banning a bot here is unrecoverable.
    if (rejectBotTarget(database, userId, reply)) return;
    const now = new Date().toISOString();
    const target = one<{ role: "owner" | "member" }>(
      database.sqlite,
      "select role from users where id = ?",
      [userId]
    );
    run(database.sqlite, "update users set banned_at = ? where id = ? and role != 'owner'", [
      now,
      userId
    ]);
    // A ban that leaves the account usable is not a ban. Revoking the sessions
    // closes the HTTP path; evicting the sockets closes the realtime path, which
    // otherwise keeps serving messages and WebRTC signalling on the connection
    // that was already open. Owners are exempt above, so skip the cascade for them.
    if (target && target.role !== "owner") {
      revokeSessionsForUser(database.sqlite, userId, now);
    }
    audit(database, owner.id, "user.banned", userId);
    database.save();
    if (target && target.role !== "owner") {
      realtime.disconnectUser(userId);
    }
    return reply.code(204).send();
  });

  server.post("/api/owner/sessions/:sessionId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    revokeSession(database.sqlite, sessionId);
    audit(database, owner.id, "session.revoked", sessionId);
    database.save();
    return reply.code(204).send();
  });
}

function registerRealtime(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase
): RealtimeModeration {
  const online: OnlineRegistry = new Map();
  const voice = createVoiceRealtime(io, database);
  const music = createMusicRealtime(io, database, voice);

  io.use((socket, next) => {
    const user = authenticateSocket(database.sqlite, socket.handshake.headers.cookie);
    if (!user) {
      next(new Error("unauthorized"));
      return;
    }

    socket.data.user = publicPresence(user);
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as PresenceUser;
    const serverIds = activeServerIds(database.sqlite, user.userId);
    for (const serverId of serverIds) {
      socket.join(`server:${serverId}`);
    }

    socket.on("connection:probe", safeSocketHandler("connection:probe", (ack) => {
      if (typeof ack === "function") ack();
    }));

    socket.on("presence:setStatus", safeSocketHandler("presence:setStatus", (status) => {
      if (status !== "online" && status !== "idle") return;
      const presence = online.get(user.userId);
      if (!presence) return;
      const before = presenceStatusOf(online, user.userId);
      if (status === "idle") presence.idleSockets.add(socket.id);
      else presence.idleSockets.delete(socket.id);
      const after = presenceStatusOf(online, user.userId);
      if (before === after) return;
      for (const serverId of serverIds) {
        io.to(`server:${serverId}`).emit("presence:serverStatus", { serverId, userId: user.userId, status: after });
      }
    }));
    const entry = online.get(user.userId);
    const isNewPresence = !entry;
    if (entry) {
      entry.sockets.add(socket.id);
    } else {
      online.set(user.userId, { user, sockets: new Set([socket.id]), idleSockets: new Set() });
    }
    for (const serverId of serverIds) {
      const serverUser = serverPresenceUser(database.sqlite, serverId, user.userId);
      socket.emit("presence:serverSnapshot", {
        serverId,
        users: serverPresenceUsers(database.sqlite, online, serverId)
      });
      if (isNewPresence && serverUser) {
        socket.to(`server:${serverId}`).emit("presence:serverOnline", { serverId, user: serverUser });
      }
    }

    socket.on("room:join", safeSocketHandler("room:join", (roomId) => {
      const parsed = roomIdPayloadSchema.safeParse(roomId);
      if (!parsed.success) return;
      const room = roomById(database.sqlite, parsed.data);
      if (!room || !serverMembership(database.sqlite, room.serverId, user.userId) || !hasActiveServerMembership(database.sqlite, room.serverId, user.userId)) {
        return;
      }
      socket.join(`room:${parsed.data}`);
    }));

    socket.on("room:leave", safeSocketHandler("room:leave", (roomId) => {
      const parsed = roomIdPayloadSchema.safeParse(roomId);
      if (!parsed.success) return;
      socket.leave(`room:${parsed.data}`);
    }));

    voice.registerHandlers(socket, user);
    music.registerHandlers(socket, user);

    socket.on("disconnect", () => {
      voice.leaveAllRooms(socket, user.userId);

      const current = online.get(user.userId);
      if (!current) {
        return;
      }
      current.sockets.delete(socket.id);
      // Dropping an idle connection can make the remaining ones the majority,
      // so the derived status has to be re-published rather than left stale.
      const wasIdle = current.idleSockets.delete(socket.id);
      if (wasIdle && current.sockets.size > 0 && presenceStatusOf(online, user.userId) === "online") {
        for (const serverId of serverIds) {
          io.to(`server:${serverId}`).emit("presence:serverStatus", { serverId, userId: user.userId, status: "online" });
        }
      }
      if (current.sockets.size === 0) {
        online.delete(user.userId);
        for (const serverId of activeServerIds(database.sqlite, user.userId)) {
          socket.to(`server:${serverId}`).emit("presence:serverOffline", { serverId, userId: user.userId });
        }
      }
    });
  });

  return {
    // Routes speak the moderation vocabulary; voice.ts owns the implementation.
    disconnectVoice: (serverId, roomId, userId) => voice.disconnectMember(serverId, roomId, userId),
    moveVoice: (serverId, userId, targetRoomId) => voice.moveMember(serverId, userId, targetRoomId),
    updateVoiceModeration: (serverId, userId, moderation) => voice.updateModeration(serverId, userId, moderation),
    disconnectUser(userId) {
      voice.forceLeave(userId, "server_access_revoked");
      for (const socket of socketsForUser(io, userId)) socket.disconnect(true);
    },
    deleteRoom(_serverId, roomId) {
      voice.deleteRoom(roomId, "room_deleted");
      for (const socket of io.sockets.sockets.values()) socket.leave(`room:${roomId}`);
    },
    deleteServer(serverId, roomIds, affectedUserIds) {
      for (const roomId of roomIds) {
        voice.deleteRoom(roomId, "server_deleted");
      }
      const affected = new Set(affectedUserIds);
      for (const socket of io.sockets.sockets.values()) {
        const socketUser = socket.data.user as PresenceUser | undefined;
        if (!socketUser || !affected.has(socketUser.userId)) continue;
        socket.leave(`server:${serverId}`);
        for (const roomId of roomIds) socket.leave(`room:${roomId}`);
        socket.emit("server:deleted", { serverId });
      }
    },
    async grantServerAccess(serverId, userId) {
      const entry = online.get(userId);
      if (!entry) return;

      const userSockets = socketsForUser(io, userId);
      await Promise.all(userSockets.map((socket) => socket.join(`server:${serverId}`)));

      const users = serverPresenceUsers(database.sqlite, online, serverId);
      const serverUser = serverPresenceUser(database.sqlite, serverId, userId);
      for (const socket of userSockets) {
        socket.emit("presence:serverSnapshot", { serverId, users });
      }
      for (const socket of io.sockets.sockets.values()) {
        const socketUser = socket.data.user as PresenceUser | undefined;
        if (serverUser && socketUser?.userId !== userId && socket.rooms.has(`server:${serverId}`)) {
          socket.emit("presence:serverOnline", { serverId, user: serverUser });
        }
      }
    },
    refreshMemberIdentity(serverId, userId) {
      const updated = serverPresenceUserIncludingBanned(database.sqlite, serverId, userId);
      if (!updated) return null;
      voice.refreshMemberIdentity(serverId, userId, updated);
      io.to(`server:${serverId}`).emit("server:memberUpdated", { serverId, user: updated });
      return updated;
    },
    revokeServerAccess(serverId, userId, reason) {
      const textRoomIds = all<{ id: string }>(
        database.sqlite,
        "select id from rooms where server_id = ? and kind = 'text'",
        [serverId]
      ).map((room) => room.id);
      voice.forceLeave(userId, "server_access_revoked", serverId);
      for (const socket of socketsForUser(io, userId)) {
        socket.leave(`server:${serverId}`);
        for (const roomId of textRoomIds) {
          socket.leave(`room:${roomId}`);
        }
        socket.emit("server:accessRevoked", { serverId, reason });
      }
      io.to(`server:${serverId}`).emit("presence:serverOffline", { serverId, userId });
    }
  };
}

function messageById(sqlite: DatabaseSync, roomId: string, messageId: string) {
  const row = one<MessageRow>(
    sqlite,
    `select messages.id, messages.room_id as roomId, messages.user_id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      messages.body, messages.created_at as createdAt,
      messages.edited_at as editedAt,
      messages.suppressed_embed_keys as suppressedEmbedKeysJson,
      messages.reply_to_message_id as replyToMessageId,
      ${replyJoinColumns}
     from messages
     join rooms on rooms.id = messages.room_id
     join server_members
       on server_members.server_id = rooms.server_id
      and server_members.user_id = messages.user_id
     join users on users.id = messages.user_id
     ${replyJoinClause}
     where messages.room_id = ?
      and messages.id = ?
      and messages.deleted_at is null`,
    [roomId, messageId]
  );
  return row ? publicMessage(row) : null;
}

function publicMessage(row: MessageRow): ChatMessage {
  let suppressedEmbedKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.suppressedEmbedKeysJson ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      suppressedEmbedKeys = parsed.filter((key): key is string => typeof key === "string").slice(0, 16);
    }
  } catch {
    suppressedEmbedKeys = [];
  }
  return {
    id: row.id,
    roomId: row.roomId,
    userId: row.userId,
    nickname: row.nickname,
    body: row.body,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    suppressedEmbedKeys,
    replyToMessageId: row.replyToMessageId,
    // Null while `replyToMessageId` is set means the quoted message has since
    // been deleted. The reply itself stays; only the excerpt goes.
    replyTo: row.replyToMessageId !== null && row.replyToUserId !== null
      ? {
        messageId: row.replyToMessageId,
        userId: row.replyToUserId,
        nickname: row.replyToNickname ?? "",
        body: replyExcerpt(row.replyToBody ?? "")
      }
      : null
  };
}

/**
 * The quote strip is one line. Trimming server-side keeps a 2,000-character
 * message from being sent in full behind every reply to it.
 */
function replyExcerpt(body: string) {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > replyExcerptMaxLength
    ? `${collapsed.slice(0, replyExcerptMaxLength)}…`
    : collapsed;
}

/**
 * A reply may only quote a live message in the same room, so the join is scoped
 * to the room rather than trusting the stored id. A quote that escaped its room
 * would disclose another room's content to someone who cannot read it.
 */
const replyJoinColumns = `quoted.user_id as replyToUserId,
      coalesce(quoted_members.nickname, quoted_users.nickname) as replyToNickname,
      quoted.body as replyToBody`;

const replyJoinClause = `left join messages quoted
       on quoted.id = messages.reply_to_message_id
      and quoted.room_id = messages.room_id
      and quoted.deleted_at is null
     left join users quoted_users on quoted_users.id = quoted.user_id
     left join server_members quoted_members
       on quoted_members.server_id = rooms.server_id
      and quoted_members.user_id = quoted.user_id`;

function normalizePublicUrl(value: string | undefined) {
  return value ? value.replace(/\/+$/, "") : null;
}
