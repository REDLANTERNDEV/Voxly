/**
 * The Music bot's control plane: how a member's request reaches the bot.
 *
 * The bot holds no authority of its own — it is an ordinary member with an
 * ordinary socket — so nothing here tells it what it may do. What this module
 * does is decide whether a request should be forwarded at all, and to whom: the
 * asker must be in the voice room they are asking about, and the room must have
 * a bot account whose process is connected. Everything the bot then performs
 * goes back through `voice:join`, `voice:setMediaState` and `rtc:signal`, where
 * the existing authorization applies to it unchanged.
 *
 * Authorization is done once, here, rather than again in the bot. A process
 * that re-decided who was allowed to ask would be a second copy of a rule the
 * server already owns, and the one that drifted would be the one nobody could
 * audit.
 *
 * Traffic goes the other way too, and only here. The bot is the single source
 * of truth for the Queue but is an ordinary member with no authority to emit to
 * a room, so it *asks* the server to give the room its Queue and the server
 * decides whether to. See `docs/adr/0005-the-bot-publishes-the-queue.md`; the
 * short version is that the publisher must be that room's own Music bot account
 * and must still be in the room, and that nothing here is stored — the server
 * is the wire, not a second copy of the Queue.
 */

import { z } from "zod";
import {
  musicIdentifierMaxLength,
  musicInputMaxLength,
  musicQueueMaxEntries,
  musicSetLogMaxLines,
  musicTitleMaxLength,
  type MusicCommand,
  type MusicCommandAck,
  type MusicControlAck,
  type MusicPublishAck,
  type MusicQueueState,
  type MusicSetLogAction,
  type PresenceUser
} from "@voxly/shared";
import { musicBotAccountFor } from "./bots.js";
import type { VoxlyDatabase } from "./db/database.js";
import { roomById } from "./rooms.js";
import { callAck, safeSocketHandler, socketsForUser, type VoxlyIoServer, type VoxlySocket } from "./socket.js";
import type { VoiceRealtime } from "./voice.js";

/**
 * The commands, as the wire carries them. A discriminated union rather than a
 * bare verb because the ones that carry data carry different data — `add` names
 * what a member typed, a skip and a removal name a Queue entry — and a flat verb
 * plus optional fields would let a `stop` arrive with a link on it. The server
 * does not interpret either value beyond its shape: which links are playable,
 * whether an input is even a link at all, and which entry an id refers to, are
 * the bot's knowledge and belong in one place.
 */
const musicCommandSchema = z.discriminatedUnion("kind", [
  // A link or a name — one field, because the bot is what decides which of the
  // two a string is (ADR-0007). Bounded and otherwise uninterpreted: a second
  // opinion here would refuse a form the bot has since learned to accept.
  z.object({ kind: z.literal("add"), input: z.string().min(1).max(musicInputMaxLength) }).strict(),
  z.object({ kind: z.literal("play") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
  // The entry a skip or a removal names. Bounded by the same constant as every
  // other opaque identifier on this wire, because it is the same kind of thing:
  // a short token the server does not parse and only ever hands back to the bot
  // that minted it. What the id *means* is the bot's business — a stale one is
  // a request that succeeds and changes nothing, which is the Queue's rule and
  // not a validation failure.
  z.object({ kind: z.literal("skip"), entryId: z.string().min(1).max(musicIdentifierMaxLength) }).strict(),
  z.object({ kind: z.literal("remove"), entryId: z.string().min(1).max(musicIdentifierMaxLength) }).strict(),
  z.object({ kind: z.literal("leave") }).strict()
]);

/**
 * The join between the shared vocabulary and this validator.
 *
 * A verb added to `MusicCommand` with no branch added here would otherwise be
 * accepted by the bot and rejected at this door, which is the failure that is
 * hardest to see: the member gets a refusal and nothing in either process looks
 * wrong. This stops the build instead.
 */
const coversEveryCommand: MusicCommand extends z.infer<typeof musicCommandSchema> ? true : never = true;
void coversEveryCommand;

const musicControlPayloadSchema = z.object({
  roomId: z.string().min(1),
  command: musicCommandSchema
}).strict();

/**
 * How long the bot gets to answer before the member is told it did not.
 *
 * Generous, because the slow part is the extractor asking the source about a
 * link — a network round trip to somebody else's servers, occasionally several
 * seconds. It must stay comfortably **longer** than the bot's own
 * `resolveTimeoutMs` plus the join that follows it: a bot cut off mid-sentence
 * reports `bot_timeout` in place of the real reason it gave up, which is the
 * one answer that tells the member nothing.
 */
export const botAckTimeoutMs = 25_000;

/**
 * The Queue, as the bot is allowed to state it.
 *
 * Everything here is bounded, because this payload is relayed to every member
 * of the room and the strings in it originate at YouTube rather than at anyone
 * Voxly authenticated. `strict()` throughout: a field nobody agreed on must not
 * ride along to every browser in the channel.
 */
const trackDurationMaxSeconds = 24 * 60 * 60;

/**
 * One line of the Set log, bounded exactly as a Queue entry is and for the same
 * reason: the title on it is the source's string, not Voxly's, and this payload
 * goes to every browser in the room. The verbs are a closed list because a verb
 * nobody agreed on is not something a member can be said to have done.
 *
 * `requestedByUserId` is nullable and the emptiness is not validated against
 * the verb. The server does not hold an opinion about which lines name a
 * member: which of them the bot writes about itself is the bot's knowledge, and
 * a second copy of that rule here would refuse a publish the bot was right to
 * make — losing the room its whole Queue over a line.
 *
 * Nothing here is stored. The server relays this payload and keeps no copy of
 * it — there is no table for a log line and no code path that would look for
 * one — which is what makes "the Set log is never written to the database"
 * enforced rather than merely true today.
 */
const musicSetLogLineSchema = z.object({
  lineId: z.string().min(1).max(musicIdentifierMaxLength),
  action: z.enum([
    "added",
    "skipped",
    "removed",
    "paused",
    "resumed",
    // The three the bot writes about itself: a Track whose turn came and would
    // not play. They carry no member, which is the only reason the field below
    // is nullable. ADR-0011.
    "failedUnavailable",
    "failedSource",
    "failedBot"
  ]),
  requestedByUserId: z.string().min(1).max(musicIdentifierMaxLength).nullable(),
  trackTitle: z.string().max(musicTitleMaxLength).nullable()
}).strict();

const musicQueueStateSchema = z.object({
  entries: z.array(z.object({
    entryId: z.string().min(1).max(musicIdentifierMaxLength),
    track: z.object({
      id: z.string().min(1).max(musicIdentifierMaxLength),
      title: z.string().max(musicTitleMaxLength),
      durationSeconds: z.number().int().min(0).max(trackDurationMaxSeconds)
    }).strict(),
    requestedByUserId: z.string().min(1).max(musicIdentifierMaxLength)
  }).strict()).max(musicQueueMaxEntries),
  playing: z.boolean(),
  log: z.array(musicSetLogLineSchema).max(musicSetLogMaxLines)
}).strict();

/**
 * The join between the shared vocabulary and this validator, as the command
 * union already has one. A verb added to `MusicSetLogAction` and forgotten here
 * would be a line the bot writes and the server refuses, which stops the whole
 * publish — the Queue with it — for something no member did wrong.
 */
const coversEverySetLogAction:
  MusicSetLogAction extends z.infer<typeof musicSetLogLineSchema>["action"] ? true : never = true;
void coversEverySetLogAction;

const musicPublishPayloadSchema = z.object({
  roomId: z.string().min(1),
  state: musicQueueStateSchema
}).strict();

export interface MusicRealtime {
  registerHandlers: (socket: VoxlySocket, user: PresenceUser) => void;
}

export function createMusicRealtime(
  io: VoxlyIoServer,
  database: VoxlyDatabase,
  voice: Pick<VoiceRealtime, "isVoiceMember">
): MusicRealtime {
  return {
    registerHandlers(socket, user) {
      socket.on("music:control", safeSocketHandler("music:control", (payload, ack) => {
        void forwardMusicCommand(io, database, voice, user.userId, payload)
          .then((response) => callAck(ack, response))
          // The request is now in flight to another process, so a fault here is
          // not something the asker can be left hanging on.
          .catch((cause: unknown) => {
            console.error("music:control failed", cause);
            callAck(ack, { ok: false, error: "bot_timeout" } satisfies MusicControlAck);
          });
      }));
      socket.on("music:publish", safeSocketHandler("music:publish", (payload, ack) => {
        callAck(ack, publishQueue(io, database, voice, user.userId, payload));
      }));
    }
  };
}

async function forwardMusicCommand(
  io: VoxlyIoServer,
  database: VoxlyDatabase,
  voice: Pick<VoiceRealtime, "isVoiceMember">,
  requestedByUserId: string,
  payload: unknown
): Promise<MusicControlAck> {
  const parsed = musicControlPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "room_not_found" };
  }

  const room = roomById(database.sqlite, parsed.data.roomId);
  if (!room || room.kind !== "voice") {
    return { ok: false, error: "room_not_found" };
  }
  // Being in the room is the whole permission: it is what makes this the
  // asker's room to change, and it is checked against live voice membership
  // rather than server membership, which everyone in the server has.
  if (!voice.isVoiceMember(room.id, requestedByUserId)) {
    return { ok: false, error: "not_in_voice_room" };
  }
  // The AFK room mutes everyone in it, the server included, so a bot summoned
  // there could only ever be a silent participant. Refusing at the door is
  // clearer than joining and going quiet.
  if (room.isAfk) {
    return { ok: false, error: "afk_room" };
  }

  const account = musicBotAccountFor(database.sqlite, room.serverId);
  if (!account) {
    return { ok: false, error: "no_music_bot" };
  }

  const sockets = socketsForUser(io, account.userId);
  const botSocket = sockets.at(-1);
  if (!botSocket) {
    return { ok: false, error: "bot_offline" };
  }
  // The most recently connected socket, and only that one. An account may
  // briefly hold two — a reconnect whose predecessor has not dropped yet — and
  // delivering to both would summon two Sets into the same room, each unaware
  // of the other. The newest is the one whose process is certainly still there.
  return await askBot(botSocket, { roomId: room.id, command: parsed.data.command, requestedByUserId });
}

/**
 * Puts the request to the bot and waits for its answer.
 *
 * The bot's answer is relayed rather than absorbed because only the bot can
 * tell whether a link resolves to something playable, and the member who pasted
 * it is owed that. What the server does *not* do is re-interpret it: every
 * refusal the bot can give is already a member-facing reason in the shared
 * contract.
 */
async function askBot(
  botSocket: VoxlySocket,
  payload: { roomId: string; command: MusicCommand; requestedByUserId: string }
): Promise<MusicControlAck> {
  try {
    // The bot's answer, whole. A refusal is already a member-facing reason in
    // the shared contract, and a success is either the Track that was queued or
    // the Results a typed name found — the second of which travels back to
    // this one member and nowhere else. Nothing here is put in front of the
    // room: `music:queue` is the only thing that is, and it comes the other way.
    const response: MusicCommandAck = await botSocket.timeout(botAckTimeoutMs).emitWithAck("music:command", payload);
    return response;
  } catch {
    // A bot that has the request and has not answered is a different problem
    // from one that is not running, and only one of the two is worth waiting
    // out, so they do not share a message.
    return { ok: false, error: "bot_timeout" };
  }
}

/**
 * The bot saying what the Queue is, on its way to everyone in the room.
 *
 * Authorized rather than relayed. Three things are checked and each of them is
 * the reason a different attack or accident does nothing: the publisher must be
 * *this server's* Music bot account, so no member — and no other server's bot —
 * can put a Queue in front of a room; and it must still be in the room, so a
 * bot an owner has just disconnected cannot go on narrating a Set it is no
 * longer part of.
 *
 * Nothing is stored. The bot is the single source of truth and republishes when
 * the room's roster changes, so a member who joins mid-Set is told by the bot
 * rather than handed the server's guess at what the bot last said.
 */
function publishQueue(
  io: VoxlyIoServer,
  database: VoxlyDatabase,
  voice: Pick<VoiceRealtime, "isVoiceMember">,
  publisherUserId: string,
  payload: unknown
): MusicPublishAck {
  const parsed = musicPublishPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "invalid_state" };

  const room = roomById(database.sqlite, parsed.data.roomId);
  if (!room || room.kind !== "voice") return { ok: false, error: "room_not_found" };

  const account = musicBotAccountFor(database.sqlite, room.serverId);
  if (!account || account.userId !== publisherUserId) return { ok: false, error: "not_authorized" };
  if (!voice.isVoiceMember(room.id, publisherUserId)) return { ok: false, error: "not_authorized" };

  // To the voice room, not the server room. Who queued what is the business of
  // the people listening, and a member idling in a text channel elsewhere has
  // no more claim on it than they have on the room's speaking state.
  io.to(`voice:${room.id}`).emit("music:queue", {
    roomId: room.id,
    state: parsed.data.state satisfies MusicQueueState
  });
  return { ok: true };
}
