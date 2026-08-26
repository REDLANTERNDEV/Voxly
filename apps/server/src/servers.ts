/**
 * A server and the rooms inside it: who may create one, rename one, delete one,
 * and how long a member may sit idle before their client parks them.
 *
 * A room only exists inside a server, and the two lifecycles are the same
 * lifecycle. Creating a server creates its first three rooms and its Music bot;
 * deleting one deletes every room in it in the same transaction; the last-room
 * floor and the last-owner-server refusal are the same rule applied one level
 * apart. Splitting them across two modules would put the halves of those pairs
 * where they cannot see each other.
 *
 * `rooms.ts` stays underneath this: it owns the row shape and the lookup that
 * `voice.ts` and `music.ts` also authorize against, and it reaches for nothing
 * live, so it can stay a leaf that everyone may import.
 *
 * This module registers its own routes; `app.ts` composes it and hands it a
 * `RouteContext`. See
 * `docs/adr/0013-route-modules-register-their-own-routes.md`.
 */

import { z } from "zod";
import {
  afkRoomName,
  DEFAULT_AFK_TIMEOUT_MINUTES,
  isAfkTimeoutMinutes,
  type AfkTimeoutMinutes,
  type RoomSummary
} from "@voxly/shared";
import { audit } from "./audit.js";
import { requireOwner, requireUser } from "./auth/sessions.js";
import { createMusicBotAccount } from "./bots.js";
import { all, defaultServerId, one, run, type VoxlyDatabase } from "./db/database.js";
import {
  activateServerMembership,
  mayCreateInvites,
  requireServerMember,
  requireServerOwner
} from "./members.js";
import { publicRoom, roomById, roomColumns, type RoomRow } from "./rooms.js";
import { authenticatedWriteLimit, type RouteContext } from "./http.js";

/**
 * Resource ceilings.
 *
 * Voxly targets small private groups, so these are deliberately far above any
 * legitimate use and exist only to stop unbounded growth on a single-file
 * SQLite database. Tune them freely — nothing else depends on the exact values.
 */
const maxRoomsPerServer = 100;
const maxServersPerOwner = 50;

export const serverNameSchema = z.string().trim().min(2).max(64);
export const roomNameSchema = z.string().trim().min(2).max(64);

export function registerServerRoutes({ fastify, database, io, realtime, secureCookies }: RouteContext) {
  fastify.get("/api/servers", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const memberships = all<{ id: string; name: string; role: "owner" | "member"; canInvite: number; afkTimeoutMinutes: number | null }>(
      database.sqlite,
      `select servers.id, servers.name, server_members.role,
        server_members.can_invite as canInvite,
        servers.afk_timeout_minutes as afkTimeoutMinutes
       from server_members
       join servers on servers.id = server_members.server_id
       where server_members.user_id = ?
         and server_members.banned_at is null
         and server_members.removed_at is null
       order by servers.created_at asc`,
      [user.id]
    );
    return {
      servers: memberships.map((membership) => ({
        ...membership,
        canInvite: mayCreateInvites(membership.role, membership.canInvite),
        afkTimeoutMinutes: afkTimeoutOf(membership.afkTimeoutMinutes)
      }))
    };
  });

  fastify.post("/api/servers", { config: authenticatedWriteLimit }, async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const body = z.object({ name: serverNameSchema }).parse(request.body);
    const ownedServers = one<{ count: number }>(
      database.sqlite,
      "select count(*) as count from servers where created_by_user_id = ?",
      [owner.id]
    )?.count ?? 0;
    if (ownedServers >= maxServersPerOwner) {
      return reply.code(409).send({ error: "server_limit_reached" });
    }
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
    createServerRoom(database, serverId, afkRoomName, "voice", 30, true);
    const bot = createMusicBotAccount(database, serverId, now);
    audit(database, owner.id, "server.created", null, serverId);
    audit(database, owner.id, "bot.created", bot.userId, serverId);
    database.save();
    await realtime.grantServerAccess(serverId, owner.id);
    return reply.code(201).send({ server: { id: serverId, name: body.name, role: "owner", canInvite: true } });
  });

  fastify.get("/api/servers/:serverId/rooms", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerMember(database, serverId, user.id, reply)) return;
    return {
      rooms: all<RoomRow>(
        database.sqlite,
        `select ${roomColumns} from rooms where server_id = ? order by position asc`,
        [serverId]
      ).map(publicRoom)
    };
  });

  fastify.post("/api/servers/:serverId/rooms", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const body = z.object({ name: roomNameSchema, kind: z.enum(["text", "voice"]) }).parse(request.body);
    const roomTotal = one<{ count: number }>(
      database.sqlite,
      "select count(*) as count from rooms where server_id = ?",
      [serverId]
    )?.count ?? 0;
    if (roomTotal >= maxRoomsPerServer) {
      return reply.code(409).send({ error: "room_limit_reached" });
    }
    const position = one<{ position: number | null }>(
      database.sqlite,
      "select max(position) as position from rooms where server_id = ?",
      [serverId]
    )?.position ?? 0;
    const room = createServerRoom(database, serverId, body.name, body.kind, position + 10);
    audit(database, owner.id, "room.created", null, serverId);
    database.save();
    // Members already in the server hold a cached room list, so a new channel is
    // invisible until they reload unless the same signal that covers deletion
    // also covers creation.
    io.to(`server:${serverId}`).emit("server:roomsChanged", { serverId });
    return reply.code(201).send({ room });
  });

  fastify.patch("/api/servers/:serverId/afk", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const { afkTimeoutMinutes } = z.object({
      afkTimeoutMinutes: z.number().int().refine(isAfkTimeoutMinutes, { message: "unsupported_timeout" })
    }).parse(request.body);
    run(database.sqlite, "update servers set afk_timeout_minutes = ? where id = ?", [afkTimeoutMinutes, serverId]);
    audit(database, owner.id, "server.afkTimeoutChanged", null, serverId);
    database.save();
    // Every member runs their own idle clock, so all of them need the new value
    // rather than only the owner who set it.
    io.to(`server:${serverId}`).emit("server:afkUpdated", { serverId, afkTimeoutMinutes });
    return { afkTimeoutMinutes };
  });

  fastify.patch("/api/servers/:serverId", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    const { name } = z.object({ name: serverNameSchema }).parse(request.body);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    run(database.sqlite, "update servers set name = ? where id = ?", [name, serverId]);
    audit(database, owner.id, "server.renamed", null, serverId);
    database.save();
    io.to(`server:${serverId}`).emit("server:updated", { serverId, name });
    return { server: { id: serverId, name, role: "owner" as const, canInvite: true } };
  });

  fastify.delete("/api/servers/:serverId/rooms/:roomId", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { serverId, roomId } = z.object({
      serverId: z.string().min(1),
      roomId: z.string().min(1)
    }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const room = roomById(database.sqlite, roomId);
    if (!room || room.serverId !== serverId) return reply.code(404).send({ error: "room_not_found" });
    const roomCount = one<{ count: number }>(database.sqlite, "select count(*) as count from rooms where server_id = ?", [serverId])?.count ?? 0;
    if (roomCount <= 1) return reply.code(409).send({ error: "last_room" });

    database.sqlite.exec("begin immediate");
    try {
      run(database.sqlite, "delete from messages where room_id = ?", [roomId]);
      run(database.sqlite, "delete from rooms where id = ? and server_id = ?", [roomId, serverId]);
      audit(database, owner.id, "room.deleted", null, serverId);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    realtime.deleteRoom(serverId, roomId);
    io.to(`server:${serverId}`).emit("server:roomsChanged", { serverId, deletedRoomId: roomId });
    return reply.code(204).send();
  });

  fastify.delete("/api/servers/:serverId", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) return;
    const { serverId } = z.object({ serverId: z.string().min(1) }).parse(request.params);
    if (!requireServerOwner(database, serverId, owner.id, reply)) return;
    const otherAccessibleServers = one<{ count: number }>(
      database.sqlite,
      `select count(*) as count from server_members
       where user_id = ? and server_id != ?
         and banned_at is null and removed_at is null`,
      [owner.id, serverId]
    )?.count ?? 0;
    if (otherAccessibleServers === 0) return reply.code(409).send({ error: "last_owner_server" });

    const roomIds = all<{ id: string }>(database.sqlite, "select id from rooms where server_id = ?", [serverId]).map((room) => room.id);
    const affectedUserIds = all<{ user_id: string }>(database.sqlite, "select user_id from server_members where server_id = ?", [serverId]).map((membership) => membership.user_id);
    database.sqlite.exec("begin immediate");
    try {
      run(database.sqlite, "delete from messages where room_id in (select id from rooms where server_id = ?)", [serverId]);
      run(database.sqlite, "delete from invite_uses where invite_id in (select id from invites where server_id = ?)", [serverId]);
      run(database.sqlite, "delete from invites where server_id = ?", [serverId]);
      run(database.sqlite, "delete from access_claims where server_id = ?", [serverId]);
      run(database.sqlite, "delete from server_members where server_id = ?", [serverId]);
      run(database.sqlite, "delete from rooms where server_id = ?", [serverId]);
      audit(database, owner.id, "server.deleted", null, serverId);
      run(database.sqlite, "delete from servers where id = ?", [serverId]);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    realtime.deleteServer(serverId, roomIds, affectedUserIds);
    return reply.code(204).send();
  });

  // The unscoped room list from before servers existed, still answering for the
  // default server. It is the same room list as the scoped route above, so it
  // lives beside it rather than wherever a client last called it from.
  fastify.get("/api/rooms", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    if (!requireServerMember(database, defaultServerId, user.id, reply)) return;

    return {
      rooms: all<RoomRow>(database.sqlite, `select ${roomColumns} from rooms where server_id = ? order by position asc`, [defaultServerId]).map(publicRoom)
    };
  });
}

/** Legacy rows carry no timeout, so the default is applied on read. */
export function afkTimeoutOf(stored: number | null | undefined): AfkTimeoutMinutes {
  return isAfkTimeoutMinutes(stored) ? stored : DEFAULT_AFK_TIMEOUT_MINUTES;
}

/**
 * The default server's first text and voice rooms keep the fixed ids they were
 * created with before rooms were server-scoped, because saved links and older
 * clients still name them. Every other room gets a UUID, so two servers may
 * hold rooms of the same name.
 */
export function createServerRoom(
  database: VoxlyDatabase,
  serverId: string,
  name: string,
  kind: "text" | "voice",
  position: number,
  isAfk = false
) {
  const id = serverId === defaultServerId && name === "general" && kind === "text"
    ? "general"
    : serverId === defaultServerId && name === "Lobby" && kind === "voice"
      ? "lobby"
      : crypto.randomUUID();
  const room: RoomSummary = { id, serverId, name, kind, position, isAfk };
  run(database.sqlite, "insert into rooms (id, server_id, name, kind, position, is_afk) values (?, ?, ?, ?, ?, ?)", [
    room.id,
    room.serverId,
    room.name,
    room.kind,
    room.position,
    room.isAfk ? 1 : 0
  ]);
  return room;
}
