/**
 * A message in a text room: reading the history, posting one, editing one,
 * suppressing a rich preview on one, and deleting one — plus the lookup and the
 * outward shape every one of those five answers with.
 *
 * They are one module because they are one row read five ways. `messageById`
 * and the history query are the same columns over the same joins, `publicMessage`
 * is the only thing that turns either into a `ChatMessage`, and the reply
 * excerpt exists solely so a quote can be carried inside that shape. Splitting
 * the handlers from the helpers would leave the two SQL statements free to
 * drift, and the drift that matters — the nickname join, the room-scoped reply
 * join — is a disclosure rule rather than a formatting detail.
 *
 * Nothing outside message code reads any of this: no other module emits
 * `message:new`, `message:updated` or `message:deleted`, and none of them needs
 * a message row. So unlike `rooms.ts` and `users.ts` this is a route group with
 * its private helpers, not a leaf everyone may import.
 *
 * This module registers its own routes; `app.ts` composes it and hands it a
 * `RouteContext`. See
 * `docs/adr/0013-route-modules-register-their-own-routes.md`.
 */

import type { DatabaseSync } from "node:sqlite";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { replyExcerptMaxLength, type ChatMessage } from "@voxly/shared";
import { requireUser } from "./auth/sessions.js";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";
import { isServerOwner, requireServerMember, serverPresenceUser } from "./members.js";
import { roomById } from "./rooms.js";
import { messageLimit, roomIdParam, type RouteContext } from "./http.js";

/** The message row as it is read back, in the spelling the two queries select. */
export type MessageRow = {
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

/**
 * How many rich-preview keys one message may carry.
 *
 * Enforced twice and deliberately named once: the embeds route refuses the key
 * past the ceiling with a 409, and `publicMessage` clamps whatever is already
 * stored. A row written before the ceiling existed, or by a future migration,
 * still reads back bounded.
 */
const maxSuppressedEmbedKeys = 16;

/** The bounds on a message body, shared by posting one and editing one. */
const messageBodySchema = z.string().trim().min(1).max(2000);

/** Path parameters for the three routes that address one message. */
const messageParamsSchema = z.object({ roomId: roomIdParam, messageId: z.string().uuid() });

export function registerMessageRoutes(context: RouteContext) {
  const { fastify, database, io, secureCookies } = context;

  fastify.get("/api/rooms/:roomId/messages", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    if (!requireTextRoom(database, roomId, user.id, reply)) return;
    const { limit } = z.object({
      limit: z.coerce.number().int().positive().max(200).default(100)
    }).parse(request.query ?? {});

    const messages = all<MessageRow>(
      database.sqlite,
      `select ${messageColumns}
       ${messageSources}
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

  fastify.post("/api/rooms/:roomId/messages", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    const body = z.object({
      body: messageBodySchema,
      replyToMessageId: z.string().min(1).max(64).optional()
    }).parse(request.body);
    // Spelled out rather than using `requireTextRoom`, and the order is the
    // answer rather than an accident. Posting into a voice room is a request
    // that names a real room and is refused for what it asks, so it is a 400
    // and it comes last: a caller with no business in the server learns the
    // room exists and nothing more. The four routes that only ever read or
    // amend an existing message have no such distinction to draw, so a wrong
    // room kind is indistinguishable from a missing room to them. The body is
    // parsed first here for the same reason it is in the two edits — a
    // malformed request is answered before anything is looked up.
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

  fastify.patch("/api/rooms/:roomId/messages/:messageId", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = messageParamsSchema.parse(request.params);
    const body = z.object({ body: messageBodySchema }).parse(request.body);
    if (!requireTextRoom(database, roomId, user.id, reply)) return;
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) {
      return reply.code(404).send({ error: "message_not_found" });
    }
    // Editing is authorship, not moderation: an owner may delete someone
    // else's message but never rewrite it.
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

  fastify.patch("/api/rooms/:roomId/messages/:messageId/embeds", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { roomId, messageId } = messageParamsSchema.parse(request.params);
    const { embedKey } = z.object({
      embedKey: z.string().min(3).max(160).regex(/^(youtube|x|vimeo|spotify):[A-Za-z0-9:_-]+$/u)
    }).parse(request.body);
    const room = requireTextRoom(database, roomId, user.id, reply);
    if (!room) return;
    const current = messageById(database.sqlite, roomId, messageId);
    if (!current) return reply.code(404).send({ error: "message_not_found" });
    if (current.userId !== user.id && !isServerOwner(database.sqlite, room.serverId, user.id)) {
      return reply.code(403).send({ error: "forbidden" });
    }

    if (!current.suppressedEmbedKeys.includes(embedKey)) {
      if (current.suppressedEmbedKeys.length >= maxSuppressedEmbedKeys) {
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

  fastify.delete("/api/rooms/:roomId/messages/:messageId", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId, messageId } = messageParamsSchema.parse(request.params);
    const room = requireTextRoom(database, roomId, user.id, reply);
    if (!room) return;
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
}

/**
 * The text room a message route addresses, or `null` when the caller has
 * already been answered — 404 for a room that is missing or is not a text
 * room, 403 for a caller with no active membership of its server.
 *
 * `http.ts`'s `requireJoinedServer` does not fit: these routes are room-scoped
 * and take the server from the room row rather than from a `:serverId` path
 * parameter, so the room lookup has to happen before the membership check
 * rather than after it.
 *
 * A missing room and a voice room answer alike here on purpose. Reading,
 * editing, suppressing a preview on and deleting a message are all operations
 * on a message that a voice room can never hold, so "no such message here" is
 * the whole truth; only `POST` has a request worth refusing on its own terms,
 * and it says so where it spells its own steps out.
 */
function requireTextRoom(database: VoxlyDatabase, roomId: string, userId: string, reply: FastifyReply) {
  const room = roomById(database.sqlite, roomId);
  if (!room || room.kind !== "text") {
    reply.code(404).send({ error: "room_not_found" });
    return null;
  }
  if (!requireServerMember(database, room.serverId, userId, reply)) return null;
  return room;
}

export function messageById(sqlite: DatabaseSync, roomId: string, messageId: string) {
  const row = one<MessageRow>(
    sqlite,
    `select ${messageColumns}
     ${messageSources}
     where messages.room_id = ?
      and messages.id = ?
      and messages.deleted_at is null`,
    [roomId, messageId]
  );
  return row ? publicMessage(row) : null;
}

/**
 * Everything a caller may learn about a message, and deliberately nothing else.
 *
 * The stored suppression list is whatever JSON is on the row, so it is parsed
 * defensively: a value that is not an array, or not JSON at all, reads back as
 * an empty list rather than turning every read of that room's history into a
 * 500.
 */
export function publicMessage(row: MessageRow): ChatMessage {
  let suppressedEmbedKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.suppressedEmbedKeysJson ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      suppressedEmbedKeys = parsed
        .filter((key): key is string => typeof key === "string")
        .slice(0, maxSuppressedEmbedKeys);
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
 *
 * `replyExcerptMaxLength` comes from `@voxly/shared` because the web client
 * lays the same strip out and has to agree on where it ends.
 */
export function replyExcerpt(body: string) {
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

/**
 * The columns and the joins behind them, written once so the history query and
 * the single-row lookup cannot come to disagree about what a message is. Only
 * the where clause and the ordering differ between the two.
 */
const messageColumns = `messages.id, messages.room_id as roomId, messages.user_id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      messages.body, messages.created_at as createdAt,
      messages.edited_at as editedAt,
      messages.suppressed_embed_keys as suppressedEmbedKeysJson,
      messages.reply_to_message_id as replyToMessageId,
      ${replyJoinColumns}`;

/**
 * The inner join to `server_members` is load-bearing, not incidental: it is
 * what lets a message carry the author's per-server nickname rather than their
 * account name. Kicking sets `removed_at` and leaves the row, so every author
 * of a live message still has one and the join is total. Loosening it to a left
 * join would silently change the fallback for every message in every room.
 */
const messageSources = `from messages
     join rooms on rooms.id = messages.room_id
     join server_members
       on server_members.server_id = rooms.server_id
      and server_members.user_id = messages.user_id
     join users on users.id = messages.user_id
     ${replyJoinClause}`;
