/**
 * What the bot does when a member asks it for something.
 *
 * One of these per connected server, because a Set belongs to a voice room and
 * a socket is scoped to one server. It holds at most one Set at a time: the bot
 * is one account with one voice membership, so being summoned somewhere else is
 * a move rather than a second Set.
 *
 * Commands are handled one at a time. They arrive from a socket, which does not
 * wait for the previous one to finish, and joining a room is several round
 * trips long — two overlapping Summons would otherwise race to own the same
 * membership.
 */

import type { MusicCommand, VoiceForceLeaveReason } from "@voxly/shared";
import { createMusicSet, type MusicSet, type SetSocket } from "./set.js";
import type { IceServer } from "./voxly.js";

export interface MusicResponderOptions {
  socket: SetSocket;
  selfUserId: string;
  /** The bundled Track, read and packetised once for the whole process. */
  packets: Buffer[];
  /** Re-read per Set: TURN credentials are short-lived and minted per user. */
  loadIceServers: () => Promise<IceServer[]>;
  createSet?: typeof createMusicSet;
  log?: (message: string) => void;
}

export interface MusicResponder {
  handle: (command: MusicCommand, roomId: string) => Promise<void>;
  /** Ends any Set in progress. Used when the connection goes away. */
  close: () => Promise<void>;
  currentRoomId: () => string | null;
}

export function createMusicResponder(options: MusicResponderOptions): MusicResponder {
  const log = options.log ?? (() => undefined);
  const createSet = options.createSet ?? createMusicSet;
  let set: MusicSet | null = null;
  let queue: Promise<void> = Promise.resolve();

  async function endCurrentSet() {
    const current = set;
    set = null;
    if (current) await current.end();
  }

  /**
   * Voice moderation applies to the bot exactly as it does to a person, so an
   * owner disconnecting it — or the room being deleted underneath it — ends the
   * Set rather than leaving one pointed at a membership the server has already
   * dropped. Without this the bot would hold peer connections nobody is on the
   * other end of, and the next Summon into that room would find a Set that
   * looks live and play into nothing.
   */
  const onForceLeave = (payload: { roomId: string; reason: VoiceForceLeaveReason }) => {
    if (set?.roomId !== payload.roomId) return;
    log(`the server removed the bot from room ${payload.roomId} (${payload.reason}); ending the Set.`);
    queue = queue.then(() => endCurrentSet()).catch(() => undefined);
  };
  options.socket.onForceLeave(onForceLeave);

  async function play(roomId: string) {
    // Being summoned into a different room ends the Set that was running. The
    // server would evict the bot from its previous room on join anyway; doing
    // it here means the mesh and the player are torn down with it rather than
    // left writing into connections nobody is on the other end of.
    if (set && set.roomId !== roomId) await endCurrentSet();
    if (!set) {
      // Failing to reach the RTC configuration is not fatal. An empty list
      // still connects two peers that can see each other directly, which is the
      // common self-hosted case, and refusing to play at all would be a worse
      // answer than playing without TURN.
      const iceServers = await options.loadIceServers().catch((cause: unknown) => {
        log(`could not read the RTC configuration (${String(cause)}); continuing without TURN`);
        return [] as IceServer[];
      });
      // Held before it is begun, so a join that fails part-way through is a Set
      // the error path can find and end rather than one left holding a
      // membership nothing points at any more.
      set = createSet({
        socket: options.socket,
        roomId,
        selfUserId: options.selfUserId,
        iceServers,
        packets: options.packets,
        log
      });
      await set.begin();
    }
    set.play();
  }

  async function apply(command: MusicCommand, roomId: string) {
    if (command === "play") {
      await play(roomId);
      return;
    }
    // Stop and leave name the room they mean, so a command that raced a move
    // does not silence a Set the asker was never in.
    if (!set || set.roomId !== roomId) return;
    if (command === "stop") {
      set.stop();
      return;
    }
    await endCurrentSet();
  }

  return {
    handle(command, roomId) {
      queue = queue.then(() => apply(command, roomId)).catch((cause: unknown) => {
        // A failed Summon must not take the process down, and must not leave a
        // half-built Set behind for the next command to trip over.
        log(`the ${command} request for room ${roomId} failed: ${String(cause)}`);
        return endCurrentSet().catch(() => undefined);
      });
      return queue;
    },
    close() {
      options.socket.offForceLeave(onForceLeave);
      queue = queue.then(() => endCurrentSet()).catch(() => undefined);
      return queue;
    },
    currentRoomId: () => set?.roomId ?? null
  };
}
