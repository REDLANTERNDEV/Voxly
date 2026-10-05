import { z } from "zod";
import type { NotificationStateResponse, ServerNotificationMute, RoomUnreadState } from "@voxly/shared";
import { requireUser } from "./auth/sessions.js";
import { activeServerMembership, requireServerMember } from "./members.js";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";
import { roomById } from "./rooms.js";
import { requireJoinedServer, roomIdParam, type RouteContext } from "./http.js";
import { socketsForUser, type VoxlyIoServer } from "./socket.js";

export function notificationState(database: VoxlyDatabase, userId: string, now = Date.now()): NotificationStateResponse {
  const memberships = all<{ serverId: string; muted: number; until: string | null }>(database.sqlite,
    `select server_id as serverId, message_notifications_muted as muted, message_notifications_mute_until as until
     from server_members where user_id = ? and removed_at is null and banned_at is null`, [userId]);
  return { serverTime: new Date(now).toISOString(), servers: memberships.filter(member => activeServerMembership(database.sqlite, member.serverId, userId)).map(member => {
    const mute: ServerNotificationMute = !member.muted || (member.until !== null && Date.parse(member.until) <= now)
      ? { mode: "enabled" } : member.until === null ? { mode: "indefinite" } : { mode: "until", until: member.until };
    const rooms = all<RoomUnreadState & Record<string, unknown>>(database.sqlite, `select rooms.id as roomId,
      rooms.message_sequence as latestSequence, coalesce(c.last_read_sequence, 0) as lastReadSequence,
      (select count(*) from messages m where m.room_id = rooms.id and m.sequence > coalesce(c.last_read_sequence, 0)
        and m.user_id != ? and m.deleted_at is null) as unreadCount
      from rooms left join room_read_cursors c on c.room_id = rooms.id and c.user_id = ?
      where rooms.server_id = ? and rooms.kind = 'text'`, [userId, userId, member.serverId]);
    return { serverId: member.serverId, mute, rooms };
  }) };
}

/** Personal changes go only to the Account's still-authorized Devices. */
function invalidateAccount(io: VoxlyIoServer, database: VoxlyDatabase, userId: string, serverId: string) {
  if (!activeServerMembership(database.sqlite, serverId, userId)) return;
  for (const socket of socketsForUser(io, userId)) socket.emit("notifications:changed", { serverId });
}

export function registerNotificationRoutes(context: RouteContext) {
  const { fastify, database, io, secureCookies } = context;
  fastify.get("/api/notifications", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    return notificationState(database, user.id);
  });
  fastify.put("/api/rooms/:roomId/read-state", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    const { throughSequence } = z.object({ throughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).parse(request.body);
    const room = roomById(database.sqlite, roomId);
    if (!room || room.kind !== "text") return reply.code(404).send({ error: "room_not_found" });
    if (!requireServerMember(database, room.serverId, user.id, reply)) return;
    const latest = one<{ sequence: number }>(database.sqlite, "select message_sequence as sequence from rooms where id = ?", [roomId])!.sequence;
    if (throughSequence > latest) return reply.code(400).send({ error: "read_sequence_invalid" });
    run(database.sqlite, `insert into room_read_cursors(user_id, room_id, last_read_sequence) values (?, ?, ?)
      on conflict(user_id, room_id) do update set last_read_sequence = max(last_read_sequence, excluded.last_read_sequence)`, [user.id, roomId, throughSequence]);
    database.save();
    invalidateAccount(io, database, user.id, room.serverId);
    return { throughSequence: one<{ sequence: number }>(database.sqlite, "select last_read_sequence as sequence from room_read_cursors where user_id = ? and room_id = ?", [user.id, roomId])!.sequence };
  });
  fastify.patch("/api/servers/:serverId/notification-settings", async (request, reply) => {
    const scope = requireJoinedServer(context, request, reply);
    if (!scope) return;
    const body = z.discriminatedUnion("mode", [z.object({ mode: z.literal("enabled") }),
      z.object({ mode: z.literal("indefinite") }),
      z.object({ mode: z.literal("timed"), durationMinutes: z.union([z.literal(15), z.literal(60), z.literal(180), z.literal(480), z.literal(1440)]) })]).parse(request.body);
    const until = body.mode === "timed" ? new Date(Date.now() + body.durationMinutes * 60_000).toISOString() : null;
    run(database.sqlite, `update server_members set message_notifications_muted = ?, message_notifications_mute_until = ?
      where server_id = ? and user_id = ?`, [body.mode === "enabled" ? 0 : 1, until, scope.serverId, scope.user.id]);
    database.save();
    invalidateAccount(io, database, scope.user.id, scope.serverId);
    return notificationState(database, scope.user.id);
  });
}
