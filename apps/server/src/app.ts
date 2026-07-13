import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Server } from "socket.io";
import { z } from "zod";
import type {
  ClientToServerEvents,
  PresenceUser,
  RtcSignalAck,
  ServerToClientEvents,
  VisualMediaKind,
  VisualTarget,
  VoiceSetVisualSubscriptionsAck,
  VoiceMediaState,
  VoiceMemberState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { consumeOwnerClaim } from "./auth/ownerClaims.js";
import { all, defaultServerId, dumpTables, one, openDatabase, run, type VoxlyDatabase } from "./db/database.js";
import type { TurnstileConfig } from "./turnstile.js";
import type { RtcConfigProvider } from "./rtcConfig.js";

const sessionCookieName = "voxly_session";
const sessionDays = 180;
const sessionRenewWindowDays = 30;

export interface CreateVoxlyAppOptions {
  databasePath: string;
  publicUrl?: string;
  ownerBootstrapToken?: string;
  allowHttpOwnerBootstrap?: boolean;
  secureCookies: boolean;
  rtc?: RtcConfigProvider;
  turnstile?: TurnstileConfig;
  webDistPath?: string;
}

export interface AuthUser {
  id: string;
  nickname: string;
  role: "owner" | "member";
  bannedAt: string | null;
  sessionId: string;
  sessionExpiresAt: string;
}

export interface VoxlyApp {
  server: FastifyInstance;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  sqlite: DatabaseSync;
  dumpTables: () => Record<string, unknown>;
  close: () => Promise<void>;
}

type UserRow = {
  id: string;
  nickname: string;
  role: "owner" | "member";
  banned_at: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
};

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
};

type RoomRow = {
  id: string;
  serverId: string;
  name: string;
  kind: "text" | "voice";
  position: number;
};

type ServerMemberRow = {
  server_id: string;
  user_id: string;
  role: "owner" | "member";
  banned_at: string | null;
  removed_at: string | null;
};

type VoiceRoomMembership = Map<string, VoiceMemberState>;
type VisualSubscriptions = Map<string, Map<string, Set<VisualMediaKind>>>;

interface RealtimeModeration {
  disconnectVoice: (serverId: string, roomId: string, userId: string) => boolean;
  grantServerAccess: (serverId: string, userId: string) => Promise<void>;
  revokeServerAccess: (serverId: string, userId: string, reason: "banned" | "kicked") => void;
}

const visualSubscriptionsPayloadSchema = z.object({
  roomId: z.string().min(1),
  targets: z.array(z.object({
    publisherUserId: z.string().min(1),
    kind: z.enum(["camera", "screen"])
  }).strict()).max(6)
}).strict();

const visualPublisherLimit = 3;
const serverNameSchema = z.string().trim().min(2).max(64);
const roomNameSchema = z.string().trim().min(2).max(64);
const inviteBodySchema = z.object({
  label: z.string().trim().min(1).max(80),
  expiresInHours: z.number().int().positive().max(168).optional()
});

export async function createVoxlyApp(options: CreateVoxlyAppOptions): Promise<VoxlyApp> {
  const database = await openDatabase(options.databasePath);
  const server = Fastify({ logger: false });
  await server.register(cookie);
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: "bad_request" });
      return;
    }
    throw error;
  });

  const io = new Server<ClientToServerEvents, ServerToClientEvents>(server.server, {
    serveClient: false
  });

  const realtime = registerRealtime(io, database);
  registerRoutes(server, database, options, io, realtime);
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

function registerRoutes(
  server: FastifyInstance,
  database: VoxlyDatabase,
  options: CreateVoxlyAppOptions,
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  realtime: RealtimeModeration
) {
  server.get("/api/config", async () => {
    return {
      publicUrl: normalizePublicUrl(options.publicUrl),
      turnstile: options.turnstile ? { siteKey: options.turnstile.siteKey } : null
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
    server.post("/api/bootstrap/owner", async (request, reply) => {
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

  server.post("/api/setup/owner/claim", async (request, reply) => {
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

  server.post("/api/invites/accept", async (request, reply) => {
    const body = z.object({
      inviteToken: z.string().min(24),
      nickname: nicknameSchema.optional(),
      turnstileToken: z.string().optional()
    }).parse(request.body);

    const existingUser = authenticateHttp(database, request, reply, options.secureCookies);

    if (!existingUser && options.turnstile?.enabled) {
      const ok = await verifyTurnstile(options.turnstile.secretKey, body.turnstileToken, options.turnstile.expectedHostname);
      if (!ok) {
        return reply.code(403).send({ error: "turnstile_failed" });
      }
    }

    const invite = one<{ id: string; server_id: string; used_at: string | null; expires_at: string | null; revoked_at: string | null }>(
      database.sqlite,
      "select id, server_id, used_at, expires_at, revoked_at from invites where token_hash = ?",
      [hashToken(body.inviteToken)]
    );
    if (!invite || invite.used_at || invite.revoked_at || isExpired(invite.expires_at)) {
      return reply.code(404).send({ error: "invite_invalid" });
    }

    if (!existingUser && !body.nickname) {
      return reply.code(400).send({ error: "nickname_required" });
    }

    const member = existingUser ? serverMembership(database.sqlite, invite.server_id, existingUser.id) : null;
    if (member?.banned_at) {
      return reply.code(403).send({ error: "server_banned" });
    }
    if (member && !member.removed_at) {
      return reply.code(409).send({ error: "already_server_member", serverId: invite.server_id });
    }

    const user = existingUser ?? createUser(database, body.nickname as string, "member");
    const now = new Date().toISOString();
    activateServerMembership(database, invite.server_id, user.id, "member", now);
    run(database.sqlite, "update invites set used_by_user_id = ?, used_at = ? where id = ?", [
      user.id,
      now,
      invite.id
    ]);
    database.save();
    await realtime.grantServerAccess(invite.server_id, user.id);
    if (!existingUser) {
      const token = createSession(database, user.id);
      setSessionCookie(reply, token, options.secureCookies);
    }

    return reply.code(existingUser ? 200 : 201).send({ user: publicUser(user), serverId: invite.server_id });
  });

  server.post("/api/logout", async (request, reply) => {
    const user = authenticate(database.sqlite, request.cookies[sessionCookieName]);
    if (user) {
      run(database.sqlite, "update sessions set revoked_at = ? where id = ?", [
        new Date().toISOString(),
        user.sessionId
      ]);
      database.save();
    }
    reply.clearCookie(sessionCookieName, { path: "/" });
    return reply.code(204).send();
  });

  server.get("/api/servers", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) return;
    return {
      servers: all(
        database.sqlite,
        `select servers.id, servers.name, server_members.role
         from server_members
         join servers on servers.id = server_members.server_id
         where server_members.user_id = ?
           and server_members.banned_at is null
           and server_members.removed_at is null
         order by servers.created_at asc`,
        [user.id]
      )
    };
  });

  server.post("/api/servers", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const body = z.object({ name: serverNameSchema }).parse(request.body);
    const serverId = crypto.randomUUID();
    const now = new Date().toISOString();
    run(database.sqlite, "insert into servers (id, name, created_by_user_id, created_at) values (?, ?, ?, ?)", [
      serverId,
      body.name,
      owner.id,
      now
    ]);
    activateServerMembership(database, serverId, owner.id, "owner", now);
    createServerRoom(database, serverId, "general", "text", 10);
    createServerRoom(database, serverId, "Lobby", "voice", 20);
    audit(database, owner.id, "server.created", null, serverId);
    database.save();
    await realtime.grantServerAccess(serverId, owner.id);
    return reply.code(201).send({ server: { id: serverId, name: body.name, role: "owner" } });
  });

  server.get("/api/servers/:serverId/rooms", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerMember(database, serverId, user.id, reply)) return;
    return {
      rooms: all<RoomRow>(
        database.sqlite,
        "select id, server_id as serverId, name, kind, position from rooms where server_id = ? order by position asc",
        [serverId]
      )
    };
  });

  server.post("/api/servers/:serverId/rooms", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const body = z.object({ name: roomNameSchema, kind: z.enum(["text", "voice"]) }).parse(request.body);
    const position = one<{ position: number | null }>(
      database.sqlite,
      "select max(position) as position from rooms where server_id = ?",
      [serverId]
    )?.position ?? 0;
    const room = createServerRoom(database, serverId, body.name, body.kind, position + 10);
    audit(database, owner.id, "room.created", null, serverId);
    database.save();
    return reply.code(201).send({ room });
  });

  server.get("/api/servers/:serverId/directory", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerMember(database, serverId, user.id, reply)) return;
    return {
      members: all(
        database.sqlite,
        `select users.id as userId, users.nickname, server_members.role
         from server_members
         join users on users.id = server_members.user_id
         where server_members.server_id = ?
           and server_members.banned_at is null
           and server_members.removed_at is null
         order by users.nickname asc`,
        [serverId]
      )
    };
  });

  server.get("/api/servers/:serverId/members", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    return {
      members: all(
        database.sqlite,
        `select users.id, users.nickname, server_members.role,
          server_members.banned_at as bannedAt, server_members.removed_at as removedAt,
          server_members.joined_at as joinedAt
         from server_members
         join users on users.id = server_members.user_id
         where server_members.server_id = ?
           and server_members.removed_at is null
         order by users.nickname asc`,
        [serverId]
      )
    };
  });

  server.post("/api/servers/:serverId/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const invite = createInviteForServer(database, serverId, owner.id, inviteBodySchema.parse(request.body ?? {}));
    audit(database, owner.id, "invite.created", null, serverId);
    database.save();
    return reply.code(201).send({ invite });
  });

  server.get("/api/servers/:serverId/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    return { invites: serverInvites(database.sqlite, serverId) };
  });

  server.post("/api/servers/:serverId/invites/:inviteId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, inviteId } = z.object({ serverId: z.string().min(1), inviteId: z.string().uuid() }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const result = revokeServerInvite(database, serverId, inviteId, owner.id);
    if (result === "not_found") return reply.code(404).send({ error: "invite_not_found" });
    if (result === "inactive") return reply.code(409).send({ error: "invite_not_active" });
    return reply.code(204).send();
  });

  server.post("/api/servers/:serverId/members/:userId/:action", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, userId, action } = z.object({
      serverId: z.string().min(1),
      userId: z.string().uuid(),
      action: z.enum(["ban", "unban", "kick"])
    }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    if (userId === owner.id) return reply.code(409).send({ error: "cannot_moderate_owner" });
    const member = serverMembership(database.sqlite, serverId, userId);
    if (!member) return reply.code(404).send({ error: "member_not_found" });
    const now = new Date().toISOString();
    if (action === "ban") {
      run(database.sqlite, "update server_members set banned_at = ?, removed_at = null where server_id = ? and user_id = ?", [now, serverId, userId]);
    } else if (action === "unban") {
      run(database.sqlite, "update server_members set banned_at = null where server_id = ? and user_id = ?", [serverId, userId]);
    } else {
      run(database.sqlite, "update server_members set removed_at = ? where server_id = ? and user_id = ?", [now, serverId, userId]);
    }
    audit(database, owner.id, `member.${action}`, userId, serverId);
    database.save();
    if (action === "ban" || action === "kick") {
      realtime.revokeServerAccess(serverId, userId, action === "ban" ? "banned" : "kicked");
    }
    io.to(`server:${serverId}`).emit("server:directoryChanged", { serverId });
    return reply.code(204).send();
  });

  server.post("/api/servers/:serverId/voice/:roomId/members/:userId/disconnect", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, roomId, userId } = z.object({
      serverId: z.string().min(1),
      roomId: z.string().min(1),
      userId: z.string().uuid()
    }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const room = roomById(database.sqlite, roomId);
    if (!room || room.serverId !== serverId || room.kind !== "voice") return reply.code(404).send({ error: "room_not_found" });
    if (!realtime.disconnectVoice(serverId, roomId, userId)) return reply.code(409).send({ error: "member_not_in_voice" });
    audit(database, owner.id, "voice.disconnected", userId, serverId);
    database.save();
    return reply.code(204).send();
  });

  server.post("/api/servers/:serverId/members/:userId/access-links", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) return;
    const { serverId, userId } = z.object({ serverId: z.string().min(1), userId: z.string().uuid() }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const member = serverMembership(database.sqlite, serverId, userId);
    if (!member || member.removed_at || member.banned_at) return reply.code(404).send({ error: "member_not_found" });
    const token = createOpaqueToken();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
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

  server.post("/api/access/claim", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(24) }).parse(request.body);
    const claim = one<{ id: string; user_id: string; server_id: string; expires_at: string; consumed_at: string | null; revoked_at: string | null }>(
      database.sqlite,
      "select id, user_id, server_id, expires_at, consumed_at, revoked_at from access_claims where token_hash = ?",
      [hashToken(token)]
    );
    if (!claim || claim.consumed_at || claim.revoked_at || isExpired(claim.expires_at)) return reply.code(404).send({ error: "access_claim_invalid" });
    const user = one<UserRow>(database.sqlite, "select id, nickname, role, banned_at from users where id = ?", [claim.user_id]);
    if (!user) return reply.code(404).send({ error: "access_claim_invalid" });
    run(database.sqlite, "update access_claims set consumed_at = ? where id = ?", [new Date().toISOString(), claim.id]);
    audit(database, user.id, "access_link.consumed", user.id);
    const sessionToken = createSession(database, user.id);
    setSessionCookie(reply, sessionToken, options.secureCookies);
    return reply.code(201).send({
      user: publicUser({ ...user, bannedAt: user.banned_at }),
      serverId: claim.server_id
    });
  });

  server.post("/api/owner/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const invite = createInviteForServer(database, defaultServerId, owner.id, inviteBodySchema.parse(request.body ?? {}));
    audit(database, owner.id, "invite.created", null, defaultServerId);
    database.save();
    return reply.code(201).send({ invite });
  });

  server.get("/api/owner/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }

    return {
      invites: serverInvites(database.sqlite, defaultServerId)
    };
  });

  server.post("/api/owner/invites/:inviteId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const { inviteId } = z.object({ inviteId: z.string().uuid() }).parse(request.params);
    const result = revokeServerInvite(database, defaultServerId, inviteId, owner.id);
    if (result === "not_found") return reply.code(404).send({ error: "invite_not_found" });
    if (result === "inactive") return reply.code(409).send({ error: "invite_not_active" });
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
        `select users.id, users.nickname, server_members.role,
          server_members.banned_at as bannedAt
         from server_members join users on users.id = server_members.user_id
         where server_members.server_id = ? and server_members.removed_at is null
         order by users.nickname asc`,
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
      sessions: all(
        database.sqlite,
        `select sessions.id, sessions.user_id as userId, users.nickname,
          sessions.created_at as createdAt, sessions.expires_at as expiresAt,
          sessions.revoked_at as revokedAt
         from sessions
         join users on users.id = sessions.user_id
         order by sessions.created_at desc`
      )
    };
  });

  server.get("/api/rooms", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    if (!requireServerMember(database, defaultServerId, user.id, reply)) return;

    return {
      rooms: all(database.sqlite, "select id, server_id as serverId, name, kind, position from rooms where server_id = ? order by position asc", [defaultServerId])
    };
  });

  server.get("/api/rooms/:roomId/messages", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: z.string().min(1) }).parse(request.params);
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
          users.nickname as nickname, messages.body, messages.created_at as createdAt,
          messages.edited_at as editedAt
         from messages
         join users on users.id = messages.user_id
         where messages.room_id = ?
          and messages.deleted_at is null
         order by messages.created_at desc, messages.rowid desc
         limit ?`,
        [roomId, limit]
      ).reverse();

    return {
      messages
    };
  });

  server.post("/api/rooms/:roomId/messages", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: z.string().min(1) }).parse(request.params);
    const body = z.object({ body: z.string().trim().min(1).max(2000) }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    if (!room) {
      return reply.code(404).send({ error: "room_not_found" });
    }
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    if (room.kind !== "text") {
      return reply.code(400).send({ error: "messages_require_text_room" });
    }

    const message = {
      id: crypto.randomUUID(),
      roomId,
      userId: user.id,
      nickname: user.nickname,
      body: body.body,
      createdAt: new Date().toISOString(),
      editedAt: null
    };

    run(
      database.sqlite,
      "insert into messages (id, room_id, user_id, body, created_at) values (?, ?, ?, ?, ?)",
      [message.id, message.roomId, message.userId, message.body, message.createdAt]
    );
    database.save();
    // Every active server member needs the lightweight notification so clients
    // can maintain unread counts for text rooms they have not opened yet.
    io.to(`server:${room.serverId}`).emit("message:new", message);

    return reply.code(201).send({ message });
  });

  server.patch("/api/rooms/:roomId/messages/:messageId", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = z.object({
      roomId: z.string().min(1),
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

  server.delete("/api/rooms/:roomId/messages/:messageId", async (request, reply) => {
    const user = requireUser(database, request, reply, options.secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = z.object({
      roomId: z.string().min(1),
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
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    run(database.sqlite, "update users set banned_at = ? where id = ? and role != 'owner'", [
      new Date().toISOString(),
      userId
    ]);
    audit(database, owner.id, "user.banned", userId);
    database.save();
    return reply.code(204).send();
  });

  server.post("/api/owner/sessions/:sessionId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    run(database.sqlite, "update sessions set revoked_at = ? where id = ?", [
      new Date().toISOString(),
      sessionId
    ]);
    audit(database, owner.id, "session.revoked", sessionId);
    database.save();
    return reply.code(204).send();
  });
}

function registerRealtime(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase
): RealtimeModeration {
  const online = new Map<string, { user: PresenceUser; sockets: Set<string> }>();
  const voiceMembership = new Map<string, VoiceRoomMembership>();
  const visualSubscriptions = new Map<string, VisualSubscriptions>();

  io.use((socket, next) => {
    const sessionToken = parseCookieHeader(socket.handshake.headers.cookie ?? "")[sessionCookieName];
    const user = authenticate(database.sqlite, sessionToken);
    if (!user) {
      next(new Error("unauthorized"));
      return;
    }

    socket.data.user = publicPresence(user);
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as PresenceUser;
    const serverIds = all<{ server_id: string }>(
      database.sqlite,
      "select server_id from server_members where user_id = ? and banned_at is null and removed_at is null",
      [user.userId]
    ).map((membership) => membership.server_id);
    for (const serverId of serverIds) {
      socket.join(`server:${serverId}`);
    }
    const entry = online.get(user.userId);
    const isNewPresence = !entry;
    if (entry) {
      entry.sockets.add(socket.id);
    } else {
      online.set(user.userId, { user, sockets: new Set([socket.id]) });
    }
    for (const serverId of serverIds) {
      socket.emit("presence:serverSnapshot", {
        serverId,
        users: serverPresenceUsers(database.sqlite, online, serverId)
      });
      if (isNewPresence) socket.to(`server:${serverId}`).emit("presence:serverOnline", { serverId, user });
    }

    socket.on("room:join", (roomId) => {
      const room = roomById(database.sqlite, roomId);
      if (!room || !serverMembership(database.sqlite, room.serverId, user.userId) || !requireActiveServerMembership(database.sqlite, room.serverId, user.userId)) {
        return;
      }
      socket.join(`room:${roomId}`);
    });

    socket.on("room:leave", (roomId) => {
      socket.leave(`room:${roomId}`);
    });

    socket.on("voice:join", (roomId) => {
      const room = roomById(database.sqlite, roomId);
      if (!room || room.kind !== "voice" || !requireActiveServerMembership(database.sqlite, room.serverId, user.userId)) {
        return;
      }
      for (const [activeRoomId, members] of voiceMembership) {
        if (activeRoomId !== roomId && members.has(user.userId)) {
          leaveVoiceMember(io, database, activeRoomId, user.userId, voiceMembership, visualSubscriptions);
        }
      }
      socket.join(`voice:${roomId}`);
      const members = ensureVoiceRoom(voiceMembership, roomId);
      members.set(user.userId, {
        user,
        media: defaultVoiceMediaState()
      });
      emitVoiceSnapshot(io, database, roomId, members);
      socket.to(`server:${room.serverId}`).emit("voice:joined", { roomId, user });
    });

    socket.on("voice:leave", (roomId) => {
      leaveVoice(io, database, socket, roomId, user.userId, voiceMembership, visualSubscriptions);
    });

    socket.on("voice:snapshot", (roomId, ack) => {
      const room = roomById(database.sqlite, roomId);
      if (!room || !requireActiveServerMembership(database.sqlite, room.serverId, user.userId)) {
        ack({ roomId, members: [] });
        return;
      }
      ack(voiceSnapshot(roomId, voiceMembership.get(roomId)));
    });

    socket.on("voice:setMediaState", (payload, ack) => {
      const room = roomById(database.sqlite, payload.roomId);
      if (!room || room.kind !== "voice") {
        ack({ ok: false, error: "room_not_found" });
        return;
      }
      const members = voiceMembership.get(payload.roomId);
      const current = members?.get(user.userId);
      if (!members || !current) {
        ack({ ok: false, error: "not_in_voice_room" });
        return;
      }
      const nextMedia = normalizeVoiceMedia({ ...current.media, ...payload.media });
      if (visualPublisherCount(members, user.userId, nextMedia) > visualPublisherLimit) {
        ack({ ok: false, error: "visual_limit_reached" });
        return;
      }
      const nextState = { ...current, media: nextMedia };
      members.set(user.userId, nextState);
      clearUnavailableVisualSubscriptions(
        io,
        payload.roomId,
        user.userId,
        nextMedia,
        visualSubscriptions
      );
      emitVoiceSnapshot(io, database, payload.roomId, members);
      ack({ ok: true, state: nextState });
    });

    socket.on("voice:setVisualSubscriptions", (payload, ack) => {
      const parsed = visualSubscriptionsPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ ok: false, error: "invalid_payload" });
        return;
      }
      const response = setVisualSubscriptions(
        io,
        database,
        voiceMembership,
        visualSubscriptions,
        user.userId,
        parsed.data
      );
      ack?.(response);
    });

    socket.on("rtc:signal", (payload, ack) => {
      const response = forwardRtcSignal(io, database, voiceMembership, user.userId, payload);
      ack?.(response);
    });

    socket.on("disconnect", () => {
      for (const [roomId, members] of voiceMembership) {
        if (members.has(user.userId)) {
          leaveVoice(io, database, socket, roomId, user.userId, voiceMembership, visualSubscriptions);
        }
      }

      const current = online.get(user.userId);
      if (!current) {
        return;
      }
      current.sockets.delete(socket.id);
      if (current.sockets.size === 0) {
        online.delete(user.userId);
        const activeServerIds = all<{ server_id: string }>(
          database.sqlite,
          "select server_id from server_members where user_id = ? and banned_at is null and removed_at is null",
          [user.userId]
        ).map((membership) => membership.server_id);
        for (const serverId of activeServerIds) {
          socket.to(`server:${serverId}`).emit("presence:serverOffline", { serverId, userId: user.userId });
        }
      }
    });
  });

  return {
    disconnectVoice(serverId, roomId, userId) {
      const room = roomById(database.sqlite, roomId);
      if (!room || room.serverId !== serverId || !voiceMembership.get(roomId)?.has(userId)) {
        return false;
      }
      leaveVoiceMember(io, database, roomId, userId, voiceMembership, visualSubscriptions);
      emitVoiceForceLeave(io, userId, roomId, "owner_disconnect");
      return true;
    },
    async grantServerAccess(serverId, userId) {
      const entry = online.get(userId);
      if (!entry) return;

      const userSockets = [...io.sockets.sockets.values()].filter((socket) => {
        const socketUser = socket.data.user as PresenceUser | undefined;
        return socketUser?.userId === userId;
      });
      await Promise.all(userSockets.map((socket) => socket.join(`server:${serverId}`)));

      const users = serverPresenceUsers(database.sqlite, online, serverId);
      for (const socket of userSockets) {
        socket.emit("presence:serverSnapshot", { serverId, users });
      }
      for (const socket of io.sockets.sockets.values()) {
        const socketUser = socket.data.user as PresenceUser | undefined;
        if (socketUser?.userId !== userId && socket.rooms.has(`server:${serverId}`)) {
          socket.emit("presence:serverOnline", { serverId, user: entry.user });
        }
      }
    },
    revokeServerAccess(serverId, userId, reason) {
      const textRoomIds = all<{ id: string }>(
        database.sqlite,
        "select id from rooms where server_id = ? and kind = 'text'",
        [serverId]
      ).map((room) => room.id);
      for (const [roomId, members] of voiceMembership) {
        const room = roomById(database.sqlite, roomId);
        if (room?.serverId === serverId && members.has(userId)) {
          leaveVoiceMember(io, database, roomId, userId, voiceMembership, visualSubscriptions);
          emitVoiceForceLeave(io, userId, roomId, "server_access_revoked");
        }
      }
      for (const socket of io.sockets.sockets.values()) {
        const socketUser = socket.data.user as PresenceUser | undefined;
        if (socketUser?.userId !== userId) continue;
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

function emitVoiceForceLeave(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  userId: string,
  roomId: string,
  reason: "joined_another_room" | "owner_disconnect" | "server_access_revoked"
) {
  for (const socket of io.sockets.sockets.values()) {
    const socketUser = socket.data.user as PresenceUser | undefined;
    if (socketUser?.userId === userId) socket.emit("voice:forceLeave", { roomId, reason });
  }
}

function leaveVoice(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase,
  socket: Parameters<Parameters<Server["on"]>[1]>[0],
  roomId: string,
  userId: string,
  voiceMembership: Map<string, VoiceRoomMembership>,
  visualSubscriptions: Map<string, VisualSubscriptions>
) {
  socket.leave(`voice:${roomId}`);
  leaveVoiceMember(io, database, roomId, userId, voiceMembership, visualSubscriptions);
}

function leaveVoiceMember(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase,
  roomId: string,
  userId: string,
  voiceMembership: Map<string, VoiceRoomMembership>,
  visualSubscriptions: Map<string, VisualSubscriptions>
) {
  const members = voiceMembership.get(roomId);
  if (!members?.has(userId)) return;
  clearViewerVisualSubscriptions(io, roomId, userId, visualSubscriptions);
  clearPublisherVisualSubscriptions(roomId, userId, visualSubscriptions);
  members.delete(userId);
  if (members.size === 0) {
    voiceMembership.delete(roomId);
  }
  for (const candidate of io.sockets.sockets.values()) {
    const candidateUser = candidate.data.user as PresenceUser | undefined;
    if (candidateUser?.userId === userId) candidate.leave(`voice:${roomId}`);
  }
  const room = roomById(database.sqlite, roomId);
  if (!room) return;
  emitVoiceSnapshot(io, database, roomId, members);
  io.to(`server:${room.serverId}`).emit("voice:left", { roomId, userId });
}

function emitVoiceSnapshot(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase,
  roomId: string,
  members: VoiceRoomMembership | undefined
) {
  const room = roomById(database.sqlite, roomId);
  if (!room) return;
  io.to(`server:${room.serverId}`).emit("voice:snapshot", voiceSnapshot(roomId, members));
}

function setVisualSubscriptions(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase,
  voiceMembership: Map<string, VoiceRoomMembership>,
  visualSubscriptions: Map<string, VisualSubscriptions>,
  viewerUserId: string,
  payload: { roomId: string; targets: VisualTarget[] }
): VoiceSetVisualSubscriptionsAck {
  const room = roomById(database.sqlite, payload.roomId);
  if (!room || room.kind !== "voice") {
    return { ok: false, error: "room_not_found" };
  }
  const members = voiceMembership.get(payload.roomId);
  if (!members?.has(viewerUserId)) {
    return { ok: false, error: "not_in_voice_room" };
  }

  const targets = uniqueVisualTargets(payload.targets);
  for (const target of targets) {
    const publisher = members.get(target.publisherUserId);
    if (!publisher || target.publisherUserId === viewerUserId) {
      return { ok: false, error: "target_not_in_voice_room" };
    }
    if (!publisher.media[target.kind]) {
      return { ok: false, error: "target_visual_unavailable" };
    }
  }

  const roomSubscriptions = visualSubscriptions.get(payload.roomId) ?? new Map<string, Map<string, Set<VisualMediaKind>>>();
  const previous = roomSubscriptions.get(viewerUserId) ?? new Map<string, Set<VisualMediaKind>>();
  const next = new Map<string, Set<VisualMediaKind>>();
  for (const target of targets) {
    const kinds = next.get(target.publisherUserId) ?? new Set<VisualMediaKind>();
    kinds.add(target.kind);
    next.set(target.publisherUserId, kinds);
  }

  const publishers = new Set([...previous.keys(), ...next.keys()]);
  for (const publisherUserId of publishers) {
    const previousKinds = previous.get(publisherUserId) ?? new Set<VisualMediaKind>();
    const nextKinds = next.get(publisherUserId) ?? new Set<VisualMediaKind>();
    if (!sameVisualKinds(previousKinds, nextKinds) || nextKinds.size > 0) {
      emitVisualSubscriberState(io, payload.roomId, publisherUserId, viewerUserId, [...nextKinds]);
    }
  }

  if (next.size === 0) {
    roomSubscriptions.delete(viewerUserId);
  } else {
    roomSubscriptions.set(viewerUserId, next);
  }
  if (roomSubscriptions.size === 0) {
    visualSubscriptions.delete(payload.roomId);
  } else {
    visualSubscriptions.set(payload.roomId, roomSubscriptions);
  }

  return { ok: true, targets };
}

function clearUnavailableVisualSubscriptions(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  roomId: string,
  publisherUserId: string,
  media: VoiceMediaState,
  visualSubscriptions: Map<string, VisualSubscriptions>
) {
  const roomSubscriptions = visualSubscriptions.get(roomId);
  if (!roomSubscriptions) return;

  for (const [viewerUserId, subscriptions] of roomSubscriptions) {
    const currentKinds = subscriptions.get(publisherUserId);
    if (!currentKinds) continue;
    const nextKinds = new Set([...currentKinds].filter((kind) => media[kind]));
    if (sameVisualKinds(currentKinds, nextKinds)) continue;
    if (nextKinds.size === 0) {
      subscriptions.delete(publisherUserId);
    } else {
      subscriptions.set(publisherUserId, nextKinds);
    }
    emitVisualSubscriberState(io, roomId, publisherUserId, viewerUserId, [...nextKinds]);
  }

  cleanupVisualSubscriptions(roomId, visualSubscriptions);
}

function clearViewerVisualSubscriptions(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  roomId: string,
  viewerUserId: string,
  visualSubscriptions: Map<string, VisualSubscriptions>
) {
  const roomSubscriptions = visualSubscriptions.get(roomId);
  const subscriptions = roomSubscriptions?.get(viewerUserId);
  if (!roomSubscriptions || !subscriptions) return;
  for (const publisherUserId of subscriptions.keys()) {
    emitVisualSubscriberState(io, roomId, publisherUserId, viewerUserId, []);
  }
  roomSubscriptions.delete(viewerUserId);
  cleanupVisualSubscriptions(roomId, visualSubscriptions);
}

function clearPublisherVisualSubscriptions(
  roomId: string,
  publisherUserId: string,
  visualSubscriptions: Map<string, VisualSubscriptions>
) {
  const roomSubscriptions = visualSubscriptions.get(roomId);
  if (!roomSubscriptions) return;
  for (const subscriptions of roomSubscriptions.values()) {
    subscriptions.delete(publisherUserId);
  }
  cleanupVisualSubscriptions(roomId, visualSubscriptions);
}

function cleanupVisualSubscriptions(roomId: string, visualSubscriptions: Map<string, VisualSubscriptions>) {
  const roomSubscriptions = visualSubscriptions.get(roomId);
  if (!roomSubscriptions) return;
  for (const [viewerUserId, subscriptions] of roomSubscriptions) {
    if (subscriptions.size === 0) roomSubscriptions.delete(viewerUserId);
  }
  if (roomSubscriptions.size === 0) visualSubscriptions.delete(roomId);
}

function emitVisualSubscriberState(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  roomId: string,
  publisherUserId: string,
  viewerUserId: string,
  subscribedKinds: VisualMediaKind[]
) {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as PresenceUser | undefined;
    if (user?.userId === publisherUserId && socket.rooms.has(`voice:${roomId}`)) {
      socket.emit("voice:visualSubscriberState", { roomId, viewerUserId, subscribedKinds });
    }
  }
}

function uniqueVisualTargets(targets: VisualTarget[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.publisherUserId}:${target.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameVisualKinds(left: Set<VisualMediaKind>, right: Set<VisualMediaKind>) {
  return left.size === right.size && [...left].every((kind) => right.has(kind));
}

function createUser(database: VoxlyDatabase, nickname: string, role: "owner" | "member") {
  const user = {
    id: crypto.randomUUID(),
    nickname,
    role,
    bannedAt: null
  };
  run(database.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", [
    user.id,
    user.nickname,
    user.role
  ]);
  audit(database, user.id, "user.created", user.id);
  database.save();
  return user;
}

function activateServerMembership(
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

function serverMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  return one<ServerMemberRow>(
    sqlite,
    "select server_id, user_id, role, banned_at, removed_at from server_members where server_id = ? and user_id = ?",
    [serverId, userId]
  );
}

function isServerOwner(sqlite: DatabaseSync, serverId: string, userId: string) {
  const membership = serverMembership(sqlite, serverId, userId);
  return Boolean(membership && membership.role === "owner" && !membership.banned_at && !membership.removed_at);
}

function requireActiveServerMembership(sqlite: DatabaseSync, serverId: string, userId: string) {
  const membership = serverMembership(sqlite, serverId, userId);
  return Boolean(membership && !membership.banned_at && !membership.removed_at);
}

function serverPresenceUsers(
  sqlite: DatabaseSync,
  online: Map<string, { user: PresenceUser; sockets: Set<string> }>,
  serverId: string
) {
  return [...online.values()]
    .filter((entry) => requireActiveServerMembership(sqlite, serverId, entry.user.userId))
    .map((entry) => entry.user);
}

function requireServerMember(database: VoxlyDatabase, serverId: string, userId: string, reply: FastifyReply) {
  const membership = serverMembership(database.sqlite, serverId, userId);
  if (!membership || membership.removed_at || membership.banned_at) {
    reply.code(403).send({ error: "server_forbidden" });
    return null;
  }
  return membership;
}

function requireServerOwner(database: VoxlyDatabase, serverId: string, userId: string, reply: FastifyReply) {
  const membership = requireServerMember(database, serverId, userId, reply);
  if (!membership) return null;
  if (membership.role !== "owner") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return membership;
}

function createServerRoom(
  database: VoxlyDatabase,
  serverId: string,
  name: string,
  kind: "text" | "voice",
  position: number
) {
  const id = serverId === defaultServerId && name === "general" && kind === "text"
    ? "general"
    : serverId === defaultServerId && name === "Lobby" && kind === "voice"
      ? "lobby"
      : crypto.randomUUID();
  const room = { id, serverId, name, kind, position };
  run(database.sqlite, "insert into rooms (id, server_id, name, kind, position) values (?, ?, ?, ?, ?)", [
    room.id,
    room.serverId,
    room.name,
    room.kind,
    room.position
  ]);
  return room;
}

function createInviteForServer(
  database: VoxlyDatabase,
  serverId: string,
  createdByUserId: string,
  body: z.infer<typeof inviteBodySchema>
) {
  const token = createOpaqueToken();
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = body.expiresInHours
    ? new Date(now.getTime() + body.expiresInHours * 60 * 60 * 1000).toISOString()
    : null;
  run(
    database.sqlite,
    "insert into invites (id, server_id, token_hash, label, created_by_user_id, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    [id, serverId, hashToken(token), body.label, createdByUserId, expiresAt, now.toISOString()]
  );
  return { id, token, label: body.label, expiresAt, serverId };
}

function serverInvites(sqlite: DatabaseSync, serverId: string) {
  return all(
    sqlite,
    `select invites.id, invites.server_id as serverId, coalesce(invites.label, '') as label,
      invites.created_by_user_id as createdByUserId,
      invites.used_by_user_id as usedByUserId, invites.used_at as usedAt,
      invites.expires_at as expiresAt, invites.revoked_at as revokedAt,
      invites.created_at as createdAt
     from invites
     where invites.server_id = ?
     order by invites.created_at desc`,
    [serverId]
  );
}

function revokeServerInvite(database: VoxlyDatabase, serverId: string, inviteId: string, ownerId: string) {
  const invite = one<{ id: string; used_at: string | null; revoked_at: string | null }>(
    database.sqlite,
    "select id, used_at, revoked_at from invites where id = ? and server_id = ?",
    [inviteId, serverId]
  );
  if (!invite) return "not_found" as const;
  if (invite.used_at || invite.revoked_at) return "inactive" as const;
  run(database.sqlite, "update invites set revoked_at = ? where id = ?", [new Date().toISOString(), inviteId]);
  audit(database, ownerId, "invite.revoked", inviteId, serverId);
  database.save();
  return "revoked" as const;
}

function createSession(database: VoxlyDatabase, userId: string) {
  const token = createOpaqueToken();
  const now = new Date();
  const expiresAt = sessionExpiry(now).toISOString();
  run(
    database.sqlite,
    "insert into sessions (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), hashToken(token), userId, now.toISOString(), expiresAt]
  );
  database.save();
  return token;
}

function authenticate(sqlite: DatabaseSync, sessionToken: string | undefined): AuthUser | null {
  if (!sessionToken) {
    return null;
  }

  const session = one<SessionRow>(
    sqlite,
    "select id, user_id, expires_at, revoked_at from sessions where token_hash = ?",
    [hashToken(sessionToken)]
  );
  if (!session || session.revoked_at || isExpired(session.expires_at)) {
    return null;
  }

  const user = one<UserRow>(sqlite, "select id, nickname, role, banned_at from users where id = ?", [
    session.user_id
  ]);
  if (!user || user.banned_at) {
    return null;
  }

  return {
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    bannedAt: user.banned_at,
    sessionId: session.id,
    sessionExpiresAt: session.expires_at
  };
}

function authenticateHttp(
  database: VoxlyDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean
) {
  const sessionToken = request.cookies[sessionCookieName];
  const user = authenticate(database.sqlite, sessionToken);
  if (user && sessionToken) {
    renewSessionIfNeeded(database, user, sessionToken, reply, secureCookies);
  }
  return user;
}

function requireUser(database: VoxlyDatabase, request: FastifyRequest, reply: FastifyReply, secureCookies: boolean) {
  const user = authenticateHttp(database, request, reply, secureCookies);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

function requireOwner(database: VoxlyDatabase, request: FastifyRequest, reply: FastifyReply, secureCookies: boolean) {
  const user = requireUser(database, request, reply, secureCookies);
  if (!user) {
    return null;
  }
  if (user.role !== "owner") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

function renewSessionIfNeeded(
  database: VoxlyDatabase,
  user: AuthUser,
  sessionToken: string,
  reply: FastifyReply,
  secure: boolean
) {
  const currentExpiresAt = new Date(user.sessionExpiresAt);
  const renewalThreshold = Date.now() + sessionRenewWindowDays * 24 * 60 * 60 * 1000;
  if (currentExpiresAt.getTime() > renewalThreshold) {
    return;
  }

  const nextExpiresAt = sessionExpiry();
  run(database.sqlite, "update sessions set expires_at = ? where id = ?", [
    nextExpiresAt.toISOString(),
    user.sessionId
  ]);
  database.save();
  user.sessionExpiresAt = nextExpiresAt.toISOString();
  setSessionCookie(reply, sessionToken, secure, nextExpiresAt);
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, expires = sessionExpiry()) {
  reply.setCookie(sessionCookieName, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires
  });
}

function sessionExpiry(now = new Date()) {
  return new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);
}

function publicUser(user: AuthUser | { id: string; nickname: string; role: "owner" | "member"; bannedAt: string | null }) {
  return {
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    bannedAt: user.bannedAt
  };
}

function publicPresence(user: AuthUser): PresenceUser {
  return {
    userId: user.id,
    nickname: user.nickname,
    role: user.role
  };
}

function messageById(sqlite: DatabaseSync, roomId: string, messageId: string) {
  return one<MessageRow>(
    sqlite,
    `select messages.id, messages.room_id as roomId, messages.user_id as userId,
      users.nickname as nickname, messages.body, messages.created_at as createdAt,
      messages.edited_at as editedAt
     from messages
     join users on users.id = messages.user_id
     where messages.room_id = ?
      and messages.id = ?
      and messages.deleted_at is null`,
    [roomId, messageId]
  );
}

function roomById(sqlite: DatabaseSync, roomId: string) {
  return one<RoomRow>(
    sqlite,
    "select id, server_id as serverId, name, kind, position from rooms where id = ?",
    [roomId]
  );
}

function ensureVoiceRoom(voiceMembership: Map<string, VoiceRoomMembership>, roomId: string) {
  let members = voiceMembership.get(roomId);
  if (!members) {
    members = new Map();
    voiceMembership.set(roomId, members);
  }
  return members;
}

function voiceSnapshot(roomId: string, members: VoiceRoomMembership | undefined): VoiceSnapshot {
  return {
    roomId,
    members: members ? [...members.values()] : []
  };
}

function defaultVoiceMediaState(): VoiceMediaState {
  return {
    mic: true,
    camera: false,
    screen: false,
    deafened: false,
    speaking: false
  };
}

function normalizeVoiceMedia(media: VoiceMediaState): VoiceMediaState {
  const next = {
    mic: Boolean(media.mic),
    camera: Boolean(media.camera),
    screen: Boolean(media.screen),
    deafened: Boolean(media.deafened),
    speaking: Boolean(media.speaking)
  };

  if (next.deafened) {
    next.mic = false;
  }

  if (!next.mic || next.deafened) {
    next.speaking = false;
  }

  return next;
}

function visualPublisherCount(
  members: VoiceRoomMembership,
  currentUserId: string,
  nextCurrentMedia: VoiceMediaState
) {
  let count = nextCurrentMedia.camera || nextCurrentMedia.screen ? 1 : 0;
  for (const [userId, member] of members) {
    if (userId === currentUserId) {
      continue;
    }
    if (member.media.camera || member.media.screen) {
      count += 1;
    }
  }
  return count;
}

function forwardRtcSignal(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  database: VoxlyDatabase,
  voiceMembership: Map<string, VoiceRoomMembership>,
  fromUserId: string,
  payload: { roomId: string; toUserId: string; signal: Record<string, unknown> }
): RtcSignalAck {
  const room = roomById(database.sqlite, payload.roomId);
  if (!room || room.kind !== "voice") {
    return { ok: false, error: "room_not_found" };
  }
  const members = voiceMembership.get(payload.roomId);
  if (!members?.has(fromUserId)) {
    return { ok: false, error: "not_in_voice_room" };
  }
  if (!members.has(payload.toUserId)) {
    return { ok: false, error: "target_not_in_voice_room" };
  }
  for (const socket of io.sockets.sockets.values()) {
    const targetUser = socket.data.user as PresenceUser | undefined;
    if (targetUser?.userId === payload.toUserId && socket.rooms.has(`voice:${payload.roomId}`)) {
      socket.emit("rtc:signal", {
        roomId: payload.roomId,
        fromUserId,
        signal: payload.signal
      });
    }
  }
  return { ok: true };
}

function audit(
  database: VoxlyDatabase,
  actorUserId: string | null,
  action: string,
  targetUserId: string | null,
  serverId: string = defaultServerId
) {
  run(
    database.sqlite,
    "insert into audit_events (id, actor_user_id, action, target_user_id, server_id, created_at) values (?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), actorUserId, action, targetUserId, serverId, new Date().toISOString()]
  );
}

function parseCookieHeader(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isExpired(value: string | null) {
  return value ? new Date(value).getTime() <= Date.now() : false;
}

function normalizePublicUrl(value: string | undefined) {
  return value ? value.replace(/\/+$/, "") : null;
}

async function verifyTurnstile(secretKey: string, token: string | undefined, expectedHostname?: string) {
  if (!token) {
    return false;
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: secretKey,
        response: token
      })
    });
    if (!response.ok) {
      return false;
    }
    const result = z.object({ success: z.boolean(), hostname: z.string().optional() }).parse(await response.json());
    return result.success && (!expectedHostname || result.hostname === expectedHostname);
  } catch {
    return false;
  }
}

const nicknameSchema = z.string().trim().min(2).max(32);
