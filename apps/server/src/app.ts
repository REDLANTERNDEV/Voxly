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
  VoiceMediaState,
  VoiceMemberState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { consumeOwnerClaim } from "./auth/ownerClaims.js";
import { all, dumpTables, one, openDatabase, run, type VoxlyDatabase } from "./db/database.js";
import type { TurnstileConfig } from "./turnstile.js";

const sessionCookieName = "voxly_session";
const sessionDays = 180;
const sessionRenewWindowDays = 30;

export interface CreateVoxlyAppOptions {
  databasePath: string;
  publicUrl?: string;
  ownerBootstrapToken?: string;
  allowHttpOwnerBootstrap?: boolean;
  secureCookies: boolean;
  rtc?: {
    iceServers: IceServer[];
  };
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

type VoiceRoomMembership = Map<string, VoiceMemberState>;

const visualPublisherLimit = 3;

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

  registerRoutes(server, database, options, io);
  registerRealtime(io, database);
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
  io: Server<ClientToServerEvents, ServerToClientEvents>
) {
  server.get("/api/config", async () => {
    return {
      publicUrl: normalizePublicUrl(options.publicUrl),
      rtc: {
        iceServers: options.rtc?.iceServers ?? []
      },
      turnstile: options.turnstile ? { siteKey: options.turnstile.siteKey } : null
    };
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
      nickname: nicknameSchema,
      turnstileToken: z.string().optional()
    }).parse(request.body);

    if (options.turnstile?.enabled) {
      const ok = await verifyTurnstile(options.turnstile.secretKey, body.turnstileToken, options.turnstile.expectedHostname);
      if (!ok) {
        return reply.code(403).send({ error: "turnstile_failed" });
      }
    }

    const invite = one<{ id: string; used_at: string | null; expires_at: string | null; revoked_at: string | null }>(
      database.sqlite,
      "select id, used_at, expires_at, revoked_at from invites where token_hash = ?",
      [hashToken(body.inviteToken)]
    );
    if (!invite || invite.used_at || invite.revoked_at || isExpired(invite.expires_at)) {
      return reply.code(404).send({ error: "invite_invalid" });
    }

    const user = createUser(database, body.nickname, "member");
    const now = new Date().toISOString();
    run(database.sqlite, "update invites set used_by_user_id = ?, used_at = ? where id = ?", [
      user.id,
      now,
      invite.id
    ]);
    const token = createSession(database, user.id);
    database.save();
    setSessionCookie(reply, token, options.secureCookies);

    return reply.code(201).send({ user: publicUser(user) });
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

  server.post("/api/owner/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const body = z.object({
      label: z.string().trim().min(1).max(80),
      expiresInHours: z.number().int().positive().max(168).optional()
    }).parse(request.body ?? {});

    const token = createOpaqueToken();
    const id = crypto.randomUUID();
    const now = new Date();
    const expiresAt = body.expiresInHours
      ? new Date(now.getTime() + body.expiresInHours * 60 * 60 * 1000).toISOString()
      : null;
    run(
      database.sqlite,
      "insert into invites (id, token_hash, label, created_by_user_id, expires_at, created_at) values (?, ?, ?, ?, ?, ?)",
      [id, hashToken(token), body.label, owner.id, expiresAt, now.toISOString()]
    );
    audit(database, owner.id, "invite.created", null);
    database.save();

    return reply.code(201).send({ invite: { id, token, label: body.label, expiresAt } });
  });

  server.get("/api/owner/invites", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }

    return {
      invites: all(
        database.sqlite,
        `select invites.id, coalesce(invites.label, '') as label,
          invites.created_by_user_id as createdByUserId,
          invites.used_by_user_id as usedByUserId, invites.used_at as usedAt,
          invites.expires_at as expiresAt, invites.revoked_at as revokedAt,
          invites.created_at as createdAt
         from invites
         order by invites.created_at desc`
      )
    };
  });

  server.post("/api/owner/invites/:inviteId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, options.secureCookies);
    if (!owner) {
      return;
    }
    const { inviteId } = z.object({ inviteId: z.string().uuid() }).parse(request.params);
    const invite = one<{ id: string; used_at: string | null; revoked_at: string | null }>(
      database.sqlite,
      "select id, used_at, revoked_at from invites where id = ?",
      [inviteId]
    );
    if (!invite) {
      return reply.code(404).send({ error: "invite_not_found" });
    }
    if (invite.used_at || invite.revoked_at) {
      return reply.code(409).send({ error: "invite_not_active" });
    }
    run(database.sqlite, "update invites set revoked_at = ? where id = ?", [
      new Date().toISOString(),
      inviteId
    ]);
    audit(database, owner.id, "invite.revoked", inviteId);
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
        "select id, nickname, role, banned_at as bannedAt from users order by nickname asc"
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

    return {
      rooms: all(database.sqlite, "select id, name, kind, position from rooms order by position asc")
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
    io.to(`room:${roomId}`).emit("message:new", message);

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
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) {
      return reply.code(404).send({ error: "message_not_found" });
    }
    if (current.userId !== user.id && user.role !== "owner") {
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
) {
  const online = new Map<string, { user: PresenceUser; sockets: Set<string> }>();
  const voiceMembership = new Map<string, VoiceRoomMembership>();

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
    socket.emit("presence:snapshot", [...online.values()].map((entry) => entry.user));

    const entry = online.get(user.userId);
    if (entry) {
      entry.sockets.add(socket.id);
    } else {
      online.set(user.userId, { user, sockets: new Set([socket.id]) });
      socket.broadcast.emit("presence:online", user);
    }

    socket.on("room:join", (roomId) => {
      socket.join(`room:${roomId}`);
    });

    socket.on("room:leave", (roomId) => {
      socket.leave(`room:${roomId}`);
    });

    socket.on("voice:join", (roomId) => {
      const room = roomById(database.sqlite, roomId);
      if (!room || room.kind !== "voice") {
        return;
      }
      socket.join(`voice:${roomId}`);
      const members = ensureVoiceRoom(voiceMembership, roomId);
      members.set(user.userId, {
        user,
        media: defaultVoiceMediaState()
      });
      io.emit("voice:snapshot", voiceSnapshot(roomId, members));
      socket.broadcast.emit("voice:joined", { roomId, user });
    });

    socket.on("voice:leave", (roomId) => {
      leaveVoice(io, socket, roomId, user.userId, voiceMembership);
    });

    socket.on("voice:snapshot", (roomId, ack) => {
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
      const snapshot = voiceSnapshot(payload.roomId, members);
      io.emit("voice:snapshot", snapshot);
      ack({ ok: true, state: nextState });
    });

    socket.on("rtc:signal", (payload, ack) => {
      const response = forwardRtcSignal(io, database, voiceMembership, user.userId, payload);
      ack?.(response);
    });

    socket.on("disconnect", () => {
      for (const [roomId, members] of voiceMembership) {
        if (members.has(user.userId)) {
          leaveVoice(io, socket, roomId, user.userId, voiceMembership);
        }
      }

      const current = online.get(user.userId);
      if (!current) {
        return;
      }
      current.sockets.delete(socket.id);
      if (current.sockets.size === 0) {
        online.delete(user.userId);
        socket.broadcast.emit("presence:offline", user.userId);
      }
    });
  });
}

function leaveVoice(
  io: Server<ClientToServerEvents, ServerToClientEvents>,
  socket: Parameters<Parameters<Server["on"]>[1]>[0],
  roomId: string,
  userId: string,
  voiceMembership: Map<string, VoiceRoomMembership>
) {
  const members = voiceMembership.get(roomId);
  if (!members?.has(userId)) {
    socket.leave(`voice:${roomId}`);
    return;
  }
  members.delete(userId);
  if (members.size === 0) {
    voiceMembership.delete(roomId);
  }
  socket.leave(`voice:${roomId}`);
  io.emit("voice:snapshot", voiceSnapshot(roomId, members));
  socket.broadcast.emit("voice:left", { roomId, userId });
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
  return one<{ id: string; name: string; kind: "text" | "voice"; position: number }>(
    sqlite,
    "select id, name, kind, position from rooms where id = ?",
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

function audit(database: VoxlyDatabase, actorUserId: string | null, action: string, targetUserId: string | null) {
  run(
    database.sqlite,
    "insert into audit_events (id, actor_user_id, action, target_user_id, created_at) values (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), actorUserId, action, targetUserId, new Date().toISOString()]
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
