/**
 * Text-room messages: history, composition, mentions, reactions, pins, rich
 * previews and deletion share the same authorization and public shape.
 *
 * They are one module because they read the same message row. `messageById`
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
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  chatEmojiSet,
  maxMessageReactionKinds,
  validMentionRanges,
  rewriteMentionLabels,
  replyExcerptMaxLength,
  type ChatMessage,
  type MessageMention,
  type MessageMentionInput,
  type MessageReactionState,
  type PresenceUser
} from "@voxly/shared";
import { requireUser } from "./auth/sessions.js";
import { all, one, run, type VoxlyDatabase } from "./db/database.js";
import { isServerOwner, requireServerMember, serverPresenceUser } from "./members.js";
import { roomById } from "./rooms.js";
import { messageLimit, roomIdParam, type RouteContext } from "./http.js";

/** The message row as it is read back, in the spelling the two queries select. */
export type MessageRow = {
  mentionsJson?: string;
  reactionVersion?: number;
  pinnedAt?: string | null;
  replyToMentionsJson?: string;
  id: string;
  roomId: string;
  serverId: string;
  sequence: number;
  userId: string;
  nickname: string;
  authorDeleted: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  suppressedEmbedKeysJson: string | null;
  replyToMessageId: string | null;
  replyToUserId: string | null;
  replyToNickname: string | null;
  replyToAuthorDeleted: number | null;
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
const mentionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    userId: z.string().uuid(),
    id: z.string().uuid().optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive()
  }),
  z.object({
    kind: z.literal("everyone"),
    id: z.string().uuid().optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive()
  }),
  z.object({
    kind: z.literal("here"),
    id: z.string().uuid().optional(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive()
  })
]);
const messageBodySchema = z.string().trim().min(1).max(2000);

/** Path parameters for the three routes that address one message. */
const messageParamsSchema = z.object({ roomId: roomIdParam, messageId: z.string().uuid() });

export function registerMessageRoutes(context: RouteContext) {
  const { fastify, database, io, secureCookies } = context;

  fastify.get("/api/rooms/:roomId/pins", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    if (!requireTextRoom(database, roomId, user.id, reply)) return;
    const rows = all<MessageRow>(
      database.sqlite,
      `select ${messageColumns} ${messageSources}
      where messages.room_id = ? and messages.deleted_at is null and messages.pinned_at is not null
      order by messages.pinned_at desc, messages.sequence desc`,
      [roomId]
    );
    return { messages: rows.map((row) => publicMessage(row, database.sqlite)) };
  });

  fastify.get("/api/rooms/:roomId/messages/:messageId/context", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const { roomId, messageId } = messageParamsSchema.parse(request.params);
    if (!requireTextRoom(database, roomId, user.id, reply)) return;
    const target = messageById(database.sqlite, roomId, messageId);
    if (!target) return reply.code(404).send({ error: "message_not_found" });
    const before = all<MessageRow>(
      database.sqlite,
      `select ${messageColumns} ${messageSources}
      where messages.room_id = ? and messages.deleted_at is null and messages.sequence < ?
      order by messages.sequence desc limit 50`,
      [roomId, target.sequence]
    ).reverse();
    const after = all<MessageRow>(
      database.sqlite,
      `select ${messageColumns} ${messageSources}
      where messages.room_id = ? and messages.deleted_at is null and messages.sequence > ?
      order by messages.sequence asc limit 50`,
      [roomId, target.sequence]
    );
    // This is an old window, never a watermark for marking the latest history read.
    return {
      messages: [
        ...before.map((row) => publicMessage(row, database.sqlite)),
        target,
        ...after.map((row) => publicMessage(row, database.sqlite))
      ]
    };
  });

  for (const method of ["PUT", "DELETE"] as const) {
    fastify.route({
      method,
      url: "/api/rooms/:roomId/messages/:messageId/pin",
      config: messageLimit,
      handler: async (request, reply) => {
        const user = requireUser(database, request, reply, secureCookies);
        if (!user) return;
        const { roomId, messageId } = messageParamsSchema.parse(request.params);
        const room = requireTextRoom(database, roomId, user.id, reply);
        if (!room) return;
        if (!isServerOwner(database.sqlite, room.serverId, user.id))
          return reply.code(403).send({ error: "forbidden" });
        if (!messageById(database.sqlite, roomId, messageId))
          return reply.code(404).send({ error: "message_not_found" });
        run(
          database.sqlite,
          method === "PUT"
            ? "update messages set pinned_at = coalesce(pinned_at, ?) where id = ?"
            : "update messages set pinned_at = ? where id = ?",
          [method === "PUT" ? new Date().toISOString() : null, messageId]
        );
        database.save();
        const message = messageById(database.sqlite, roomId, messageId)!;
        io.to(`room:${roomId}`).emit("message:updated", message);
        io.to(`room:${roomId}`).emit("message:pinsChanged", { serverId: room.serverId, roomId });
        return { message };
      }
    });
  }

  function changeReactions(mode: "add" | "remove" | "clearEmoji" | "clearAll") {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const user = requireUser(database, request, reply, secureCookies);
      if (!user) return;
      const { roomId, messageId } = messageParamsSchema.parse(request.params);
      const emoji =
        mode === "clearAll"
          ? null
          : z.object({ emoji: z.string().refine((value) => chatEmojiSet.has(value)) }).parse(request.params).emoji;
      const room = requireTextRoom(database, roomId, user.id, reply);
      if (!room) return;
      if ((mode === "clearAll" || mode === "clearEmoji") && !isServerOwner(database.sqlite, room.serverId, user.id))
        return reply.code(403).send({ error: "forbidden" });
      database.sqlite.exec("BEGIN IMMEDIATE");
      let state: MessageReactionState;
      try {
        if (!messageById(database.sqlite, roomId, messageId)) {
          database.sqlite.exec("ROLLBACK");
          return reply.code(404).send({ error: "message_not_found" });
        }
        const before = reactionState(database.sqlite, messageId);
        if (mode === "add") {
          if (
            !before.reactions.some((reaction) => reaction.emoji === emoji) &&
            before.reactions.length >= maxMessageReactionKinds
          ) {
            database.sqlite.exec("ROLLBACK");
            return reply.code(409).send({ error: "reaction_limit" });
          }
          run(
            database.sqlite,
            "insert or ignore into message_reactions (message_id, user_id, emoji) values (?, ?, ?)",
            [messageId, user.id, emoji]
          );
        } else if (mode === "remove") {
          run(database.sqlite, "delete from message_reactions where message_id = ? and user_id = ? and emoji = ?", [
            messageId,
            user.id,
            emoji
          ]);
        } else if (mode === "clearEmoji") {
          run(database.sqlite, "delete from message_reactions where message_id = ? and emoji = ?", [messageId, emoji]);
        } else {
          run(database.sqlite, "delete from message_reactions where message_id = ?", [messageId]);
        }
        const after = reactionState(database.sqlite, messageId);
        if (JSON.stringify(before.reactions) !== JSON.stringify(after.reactions))
          run(database.sqlite, "update messages set reaction_version = reaction_version + 1 where id = ?", [messageId]);
        state = reactionState(database.sqlite, messageId);
        database.sqlite.exec("COMMIT");
      } catch (cause) {
        database.sqlite.exec("ROLLBACK");
        throw cause;
      }
      database.save();
      const event = { ...state, serverId: room.serverId, roomId, messageId };
      io.to(`room:${roomId}`).emit("message:reactions", event);
      return event;
    };
  }
  fastify.put(
    "/api/rooms/:roomId/messages/:messageId/reactions/:emoji",
    { config: messageLimit },
    changeReactions("add")
  );
  fastify.delete(
    "/api/rooms/:roomId/messages/:messageId/reactions/:emoji",
    { config: messageLimit },
    changeReactions("remove")
  );
  fastify.delete(
    "/api/rooms/:roomId/messages/:messageId/reactions/:emoji/all",
    { config: messageLimit },
    changeReactions("clearEmoji")
  );
  fastify.delete(
    "/api/rooms/:roomId/messages/:messageId/reactions",
    { config: messageLimit },
    changeReactions("clearAll")
  );

  fastify.get("/api/rooms/:roomId/messages", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    if (!requireTextRoom(database, roomId, user.id, reply)) return;
    const { limit } = z
      .object({
        limit: z.coerce.number().int().positive().max(200).default(100)
      })
      .parse(request.query ?? {});

    const messages = all<MessageRow>(
      database.sqlite,
      `select ${messageColumns}
       ${messageSources}
       where messages.room_id = ?
        and messages.deleted_at is null
       order by messages.created_at desc, messages.rowid desc
       limit ?`,
      [roomId, limit]
    )
      .reverse()
      .map((row) => publicMessage(row, database.sqlite));

    return {
      messages,
      readThroughSequence: one<{ sequence: number }>(
        database.sqlite,
        "select message_sequence as sequence from rooms where id = ?",
        [roomId]
      )!.sequence
    };
  });

  fastify.post("/api/rooms/:roomId/messages", { config: messageLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) {
      return;
    }
    const { roomId } = z.object({ roomId: roomIdParam }).parse(request.params);
    const body = z
      .object({
        body: messageBodySchema,
        mentions: z.array(mentionSchema).max(1000).default([]),
        replyToMessageId: z.string().min(1).max(64).optional()
      })
      .parse(request.body);
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
    const replyTarget = body.replyToMessageId ? messageById(database.sqlite, roomId, body.replyToMessageId) : null;
    if (body.replyToMessageId && !replyTarget) {
      return reply.code(404).send({ error: "reply_target_not_found" });
    }

    const sender = serverPresenceUser(database.sqlite, room.serverId, user.id);
    if (!sender) return reply.code(403).send({ error: "server_forbidden" });
    const mentions = prepareMentions(database.sqlite, io, room.serverId, body.body, body.mentions);
    if (!mentions) return reply.code(400).send({ error: "invalid_mentions" });
    const message: ChatMessage = {
      mentions,
      reactionState: { version: 0, reactions: [] },
      pinnedAt: null,
      id: crypto.randomUUID(),
      serverId: room.serverId,
      sequence: 0,
      roomId,
      userId: user.id,
      nickname: sender.nickname,
      authorDeleted: false,
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
            authorDeleted: replyTarget.authorDeleted,
            ...quotedContent(replyTarget.body, replyTarget.mentions)
          }
        : null
    };

    database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      run(database.sqlite, "update rooms set message_sequence = message_sequence + 1 where id = ?", [roomId]);
      message.sequence = one<{ sequence: number }>(
        database.sqlite,
        "select message_sequence as sequence from rooms where id = ?",
        [roomId]
      )!.sequence;
      run(
        database.sqlite,
        "insert into messages (id, room_id, user_id, body, created_at, reply_to_message_id, sequence, mentions) values (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          message.id,
          message.roomId,
          message.userId,
          message.body,
          message.createdAt,
          message.replyToMessageId,
          message.sequence,
          JSON.stringify(mentions)
        ]
      );
      database.sqlite.exec("COMMIT");
    } catch (error) {
      database.sqlite.exec("ROLLBACK");
      throw error;
    }
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
    const body = z
      .object({ body: messageBodySchema, mentions: z.array(mentionSchema).max(1000).default([]) })
      .parse(request.body);
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

    const room = roomById(database.sqlite, roomId)!;
    const mentions = prepareMentions(database.sqlite, io, room.serverId, body.body, body.mentions, current);
    if (!mentions) return reply.code(400).send({ error: "invalid_mentions" });
    const editedAt = new Date().toISOString();
    run(database.sqlite, "update messages set body = ?, edited_at = ?, mentions = ? where id = ?", [
      body.body,
      editedAt,
      JSON.stringify(mentions),
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
    const { embedKey } = z
      .object({
        embedKey: z
          .string()
          .min(3)
          .max(160)
          .regex(/^(youtube|x|vimeo|spotify):[A-Za-z0-9:_-]+$/u)
      })
      .parse(request.body);
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

    database.sqlite.exec("BEGIN IMMEDIATE");
    try {
      run(database.sqlite, "delete from message_reactions where message_id = ?", [messageId]);
      run(
        database.sqlite,
        "update messages set deleted_at = ?, deleted_by_user_id = ?, pinned_at = null where id = ?",
        [new Date().toISOString(), user.id, messageId]
      );
      database.sqlite.exec("COMMIT");
    } catch (cause) {
      database.sqlite.exec("ROLLBACK");
      throw cause;
    }
    database.save();
    io.to(`room:${roomId}`).emit("message:deleted", { roomId, messageId });
    io.to(`room:${roomId}`).emit("message:pinsChanged", { serverId: room.serverId, roomId });
    io.to(`server:${room.serverId}`).emit("notifications:changed", { serverId: room.serverId });
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
  return row ? publicMessage(row, sqlite) : null;
}

/**
 * Everything a caller may learn about a message, and deliberately nothing else.
 *
 * The stored suppression list is whatever JSON is on the row, so it is parsed
 * defensively: a value that is not an array, or not JSON at all, reads back as
 * an empty list rather than turning every read of that room's history into a
 * 500.
 */
export function publicMessage(row: MessageRow, sqlite?: DatabaseSync): ChatMessage {
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
    ...rewriteMentionLabels(row.body, resolveMentions(sqlite, row.serverId, row.mentionsJson)),
    reactionState: sqlite ? reactionState(sqlite, row.id) : { version: row.reactionVersion ?? 0, reactions: [] },
    pinnedAt: row.pinnedAt ?? null,
    id: row.id,
    roomId: row.roomId,
    serverId: row.serverId,
    sequence: row.sequence,
    userId: row.userId,
    nickname: row.nickname,
    authorDeleted: Boolean(row.authorDeleted),
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    suppressedEmbedKeys,
    replyToMessageId: row.replyToMessageId,
    // Null while `replyToMessageId` is set means the quoted message has since
    // been deleted. The reply itself stays; only the excerpt goes.
    replyTo:
      row.replyToMessageId !== null && row.replyToUserId !== null
        ? {
            messageId: row.replyToMessageId,
            userId: row.replyToUserId,
            nickname: row.replyToNickname ?? "",
            authorDeleted: Boolean(row.replyToAuthorDeleted),
            ...quotedContent(row.replyToBody ?? "", resolveMentions(sqlite, row.serverId, row.replyToMentionsJson))
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
  return collapsed.length > replyExcerptMaxLength ? `${collapsed.slice(0, replyExcerptMaxLength)}…` : collapsed;
}

/**
 * A reply may only quote a live message in the same room, so the join is scoped
 * to the room rather than trusting the stored id. A quote that escaped its room
 * would disclose another room's content to someone who cannot read it.
 */
const replyJoinColumns = `quoted.user_id as replyToUserId,
      case when quoted_users.deleted_at is null then coalesce(quoted_members.nickname, quoted_users.nickname) else '' end as replyToNickname,
      quoted_users.deleted_at is not null as replyToAuthorDeleted,
      quoted.body as replyToBody, quoted.mentions as replyToMentionsJson`;

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
const messageColumns = `rooms.server_id as serverId, messages.sequence, messages.id, messages.room_id as roomId, messages.user_id as userId,
      case when users.deleted_at is null then coalesce(server_members.nickname, users.nickname) else '' end as nickname,
      users.deleted_at is not null as authorDeleted,
      messages.mentions as mentionsJson, messages.reaction_version as reactionVersion, messages.pinned_at as pinnedAt,
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

function storedMentions(json = "[]"): MessageMention[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const result = z
      .array(
        z.intersection(
          mentionSchema,
          z.object({
            id: z.string().uuid(),
            nickname: z.string(),
            mentionCode: z.string(),
            authorDeleted: z.boolean(),
            recipientIds: z.array(z.string())
          })
        )
      )
      .max(1000)
      .safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

function resolveMentions(sqlite: DatabaseSync | undefined, serverId: string, json?: string): MessageMention[] {
  return storedMentions(json).map((mention) => {
    if (mention.kind !== "person" || !sqlite) return mention;
    const target = one<{ nickname: string; mentionCode: string; authorDeleted: number }>(
      sqlite,
      `select case when users.deleted_at is null then coalesce(server_members.nickname, users.nickname) else '' end as nickname,
        server_members.mention_code as mentionCode, users.deleted_at is not null as authorDeleted
       from server_members join users on users.id = server_members.user_id where server_members.server_id = ? and users.id = ?`,
      [serverId, mention.userId]
    );
    return {
      ...mention,
      nickname: target?.nickname ?? "",
      mentionCode: target?.mentionCode ?? "",
      authorDeleted: !target || Boolean(target.authorDeleted)
    };
  });
}

function prepareMentions(
  sqlite: DatabaseSync,
  io: RouteContext["io"],
  serverId: string,
  body: string,
  inputs: MessageMentionInput[],
  previous?: ChatMessage
): MessageMention[] | null {
  if (!validMentionRanges(body, inputs)) return null;
  const occurrenceIds = inputs.flatMap((input) => (input.id ? [input.id] : []));
  if (new Set(occurrenceIds).size !== occurrenceIds.length) return null;
  const onlineIds = new Set(
    [...io.sockets.sockets.values()].map((socket) => (socket.data.user as PresenceUser | undefined)?.userId)
  );
  const people = all<{ userId: string; nickname: string; mentionCode: string }>(
    sqlite,
    `select users.id as userId, coalesce(server_members.nickname, users.nickname) as nickname, server_members.mention_code as mentionCode
     from server_members join users on users.id = server_members.user_id where server_members.server_id = ?
       and server_members.banned_at is null and server_members.removed_at is null
       and users.banned_at is null and users.deleted_at is null and users.is_bot = 0`,
    [serverId]
  );
  const result: MessageMention[] = [];
  for (const input of inputs) {
    const retained = input.id
      ? previous?.mentions.find(
          (mention) =>
            mention.id === input.id &&
            mention.kind === input.kind &&
            (mention.kind !== "person" || (input.kind === "person" && mention.userId === input.userId))
        )
      : undefined;
    if (retained) {
      result.push({ ...retained, start: input.start, end: input.end });
      continue;
    }
    if (input.kind === "person") {
      const target = people.find((person) => person.userId === input.userId);
      // A nickname can change while a draft waits in the outbox. The stable
      // Membership identity/code must agree; readback canonicalizes the name.
      if (!target || !body.slice(input.start, input.end).endsWith(` · #${target.mentionCode}`)) return null;
      result.push({
        ...input,
        id: input.id ?? crypto.randomUUID(),
        nickname: target.nickname,
        mentionCode: target.mentionCode,
        authorDeleted: false,
        recipientIds: [target.userId]
      });
    } else {
      result.push({
        ...input,
        id: input.id ?? crypto.randomUUID(),
        nickname: "",
        mentionCode: "",
        authorDeleted: false,
        recipientIds: people
          .filter((person) => input.kind === "everyone" || onlineIds.has(person.userId))
          .map((person) => person.userId)
      });
    }
  }
  return result;
}

function reactionState(sqlite: DatabaseSync, messageId: string): MessageReactionState {
  const grouped = new Map<string, string[]>();
  for (const row of all<{ emoji: string; userId: string }>(
    sqlite,
    "select emoji, user_id as userId from message_reactions where message_id = ? order by emoji, user_id",
    [messageId]
  )) {
    grouped.set(row.emoji, [...(grouped.get(row.emoji) ?? []), row.userId]);
  }
  return {
    version:
      one<{ version: number }>(sqlite, "select reaction_version as version from messages where id = ?", [messageId])
        ?.version ?? 0,
    reactions: [...grouped].map(([emoji, userIds]) => ({ emoji, userIds }))
  };
}

/** Rebase ranges through whitespace collapse so reply excerpts keep their identity. */
function quotedContent(body: string, mentions: MessageMention[]) {
  const normalized = rewriteMentionLabels(body, mentions);
  body = normalized.body;
  mentions = normalized.mentions;
  const excerpt = replyExcerpt(body);
  const prefixLength = (end: number) => body.slice(0, end).replace(/\s+/g, " ").trimStart().length;
  return {
    body: excerpt,
    mentions: mentions
      .map((mention) => ({ ...mention, start: prefixLength(mention.start), end: prefixLength(mention.end) }))
      .filter((mention) => mention.end <= replyExcerptMaxLength && mention.end > mention.start)
  };
}
