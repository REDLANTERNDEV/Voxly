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
 *
 * Every request is answered. The answer travels back through the server to the
 * member who made it, because only this process can tell whether a pasted link
 * is something it can play, and a member who pasted a dead one is owed a
 * sentence rather than a room where nothing happens.
 */

import type { MusicCommand, MusicCommandAck, VoiceForceLeaveReason } from "@voxly/shared";
import type { BotEnvironment } from "./config.js";
import { createMusicSet, type MusicSet, type SetSocket } from "./set.js";
import { fetchTrackAudio, resolveTrack, type TrackAudio } from "./stream.js";
import { youtubeVideoUrl, type Track } from "./track.js";
import type { IceServer } from "./voxly.js";

export interface MusicResponderOptions {
  socket: SetSocket;
  selfUserId: string;
  environment: BotEnvironment;
  /** Re-read per Set: TURN credentials are short-lived and minted per user. */
  loadIceServers: () => Promise<IceServer[]>;
  createSet?: typeof createMusicSet;
  resolve?: typeof resolveTrack;
  fetch?: typeof fetchTrackAudio;
  log?: (message: string) => void;
}

export interface MusicResponder {
  handle: (command: MusicCommand, roomId: string) => Promise<MusicCommandAck>;
  /** Ends any Set in progress. Used when the connection goes away. */
  close: () => Promise<void>;
  currentRoomId: () => string | null;
}

/** Nothing to report: the request either worked or was about no Track at all. */
const acknowledged: MusicCommandAck = { ok: true, track: null };

export function createMusicResponder(options: MusicResponderOptions): MusicResponder {
  const log = options.log ?? (() => undefined);
  const createSet = options.createSet ?? createMusicSet;
  const resolveDetails = options.resolve ?? resolveTrack;
  // Not named `fetch`: the global of that name is a very different thing to
  // find shadowed halfway down a file.
  const fetchAudio = options.fetch ?? fetchTrackAudio;
  let set: MusicSet | null = null;
  let audio: TrackAudio | null = null;
  let queue: Promise<void> = Promise.resolve();

  /**
   * Abandons the fetch behind whatever was playing. A Track that has been
   * replaced or stopped is a subprocess pair nobody is reading from any more,
   * and leaving them running would cost bandwidth for audio going nowhere.
   */
  function releaseAudio() {
    audio?.cancel();
    audio = null;
  }

  async function endCurrentSet() {
    const current = set;
    set = null;
    releaseAudio();
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

  /** Joins the room if the bot is not already there, and returns the Set. */
  async function summon(roomId: string): Promise<MusicSet> {
    // Being summoned into a different room ends the Set that was running. The
    // server would evict the bot from its previous room on join anyway; doing
    // it here means the mesh and the player are torn down with it rather than
    // left writing into connections nobody is on the other end of.
    if (set && set.roomId !== roomId) await endCurrentSet();
    if (set) return set;

    // Failing to reach the RTC configuration is not fatal. An empty list still
    // connects two peers that can see each other directly, which is the common
    // self-hosted case, and refusing to play at all would be a worse answer
    // than playing without TURN.
    const iceServers = await options.loadIceServers().catch((cause: unknown) => {
      log(`could not read the RTC configuration (${String(cause)}); continuing without TURN`);
      return [] as IceServer[];
    });
    // Held before it is begun, so a join that fails part-way through is a Set
    // the error path can find and end rather than one left holding a
    // membership nothing points at any more.
    const started = createSet({
      socket: options.socket,
      roomId,
      selfUserId: options.selfUserId,
      iceServers,
      onTrackEnded: () => releaseAudio(),
      log
    });
    set = started;
    await started.begin();
    return started;
  }

  /**
   * A pasted link, from the paste to the first note.
   *
   * The order matters. The link is checked before anything is spawned, and the
   * Track is resolved before the bot joins: a member who pasted something
   * unplayable should get told so without the bot appearing in the channel,
   * playing nothing, and having to be sent away again.
   */
  async function add(roomId: string, url: string): Promise<MusicCommandAck> {
    const canonical = youtubeVideoUrl(url);
    if (!canonical) return { ok: false, error: "unsupported_link" };

    const resolved = await resolveDetails(options.environment, canonical);
    if (!resolved.ok) {
      log(`could not resolve ${canonical}: ${resolved.error}`);
      return resolved;
    }

    const current = await summon(roomId);
    startTrack(current, resolved.track);
    return { ok: true, track: summaryOf(resolved.track) };
  }

  function startTrack(current: MusicSet, track: Track) {
    releaseAudio();
    audio = fetchAudio(options.environment, track, log);
    current.loadTrack(audio.buffer);
    current.play();
    log(`playing ${track.id} (${track.title}), ${track.durationSeconds}s`);
  }

  async function apply(command: MusicCommand, roomId: string): Promise<MusicCommandAck> {
    if (command.kind === "add") return add(roomId, command.url);
    // The rest name the room they mean, so a command that raced a move does not
    // silence a Set the asker was never in. They are also about a Track that is
    // already here: with nothing loaded there is nothing for them to do, and
    // that is a request that succeeded at doing nothing rather than a failure.
    if (!set || set.roomId !== roomId) return acknowledged;
    switch (command.kind) {
      case "play":
        set.play();
        return acknowledged;
      case "stop":
        set.stop();
        return acknowledged;
      case "leave":
        await endCurrentSet();
        return acknowledged;
      default:
        // Exhaustive rather than a catch-all: a verb added to the contract
        // should stop the build here, not quietly fall into whichever branch
        // happened to be last and end the Set.
        return assertNever(command);
    }
  }

  return {
    handle(command, roomId) {
      const answered = queue.then(() => apply(command, roomId)).catch(async (cause: unknown) => {
        // A failed Summon must not take the process down, and must not leave a
        // half-built Set behind for the next command to trip over.
        log(`the ${command.kind} request for room ${roomId} failed: ${String(cause)}`);
        await endCurrentSet().catch(() => undefined);
        // Whatever went wrong here — a refused join, a mesh that would not
        // start — the link was not the problem, so this must not be reported as
        // the extractor's fault. That sentence sends the member away to wait
        // for YouTube to recover from something YouTube never did.
        return { ok: false, error: "bot_failed" } as const;
      });
      // The chain the next command waits on never rejects, because `answered`
      // has already turned every failure into an answer.
      queue = answered.then(() => undefined);
      return answered;
    },
    close() {
      options.socket.offForceLeave(onForceLeave);
      queue = queue.then(() => endCurrentSet()).catch(() => undefined);
      return queue;
    },
    currentRoomId: () => set?.roomId ?? null
  };
}

function summaryOf(track: Track) {
  return { id: track.id, title: track.title, durationSeconds: track.durationSeconds };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled music command: ${JSON.stringify(value)}`);
}
