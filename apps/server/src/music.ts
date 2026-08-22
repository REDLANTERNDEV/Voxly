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
 */

import { z } from "zod";
import { musicCommands, type MusicControlAck, type PresenceUser } from "@voxly/shared";
import { musicBotAccountFor } from "./bots.js";
import type { VoxlyDatabase } from "./db/database.js";
import { roomById } from "./rooms.js";
import { callAck, safeSocketHandler, socketsForUser, type VoxlyIoServer, type VoxlySocket } from "./socket.js";
import type { VoiceRealtime } from "./voice.js";

const musicControlPayloadSchema = z.object({
  roomId: z.string().min(1),
  // The vocabulary is the shared one, so a verb added there is accepted here
  // without a second list to keep in step.
  command: z.enum(musicCommands)
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
        callAck(ack, forwardMusicCommand(io, database, voice, user.userId, payload));
      }));
    }
  };
}

function forwardMusicCommand(
  io: VoxlyIoServer,
  database: VoxlyDatabase,
  voice: Pick<VoiceRealtime, "isVoiceMember">,
  requestedByUserId: string,
  payload: unknown
): MusicControlAck {
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
  if (sockets.length === 0) {
    return { ok: false, error: "bot_offline" };
  }
  for (const botSocket of sockets) {
    botSocket.emit("music:command", { roomId: room.id, command: parsed.data.command, requestedByUserId });
  }
  return { ok: true };
}
