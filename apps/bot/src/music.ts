/**
 * What the bot does when a member asks it for something.
 *
 * One of these per connected server, because a Set belongs to a voice room and
 * a socket is scoped to one server. It holds at most one Set at a time: the bot
 * is one account with one voice membership, so being summoned somewhere else is
 * a move rather than a second Set.
 *
 * This is the imperative half of the feature. What the Queue *is* — appending
 * rather than interrupting, advancing when a Track ends, what a pause leaves
 * behind — is decided by `playback.ts`, which is pure. Everything here is the
 * part that cannot be: joining a room, spawning an extractor, writing frames,
 * and telling the room what the answer was.
 *
 * Commands are handled one at a time. They arrive from a socket, which does not
 * wait for the previous one to finish, and joining a room is several round
 * trips long — two overlapping Summons would otherwise race to own the same
 * membership. A Track ending goes through the same chain, so it cannot land
 * halfway through a command that was already changing the Queue.
 *
 * Every request is answered. The answer travels back through the server to the
 * member who made it, because only this process can tell whether a pasted link
 * is something it can play, and a member who pasted a dead one is owed a
 * sentence rather than a room where nothing happens.
 */

import { randomUUID } from "node:crypto";
import type { MusicCommand, MusicCommandAck, MusicQueueState, VoiceForceLeaveReason } from "@voxly/shared";
import type { BotEnvironment } from "./config.js";
import {
  additionRefusal,
  advancePlayback,
  emptyPlayback,
  publishedQueue,
  type PlaybackEffect,
  type PlaybackEvent,
  type PlaybackState,
  type QueueEntry
} from "./playback.js";
import { createMusicSet, type MusicSet, type SetSocket } from "./set.js";
import { fetchTrackAudio, resolveTrack, type TrackAudio } from "./stream.js";
import { youtubeVideoUrl, type Track } from "./track.js";
import type { IceServer } from "./voxly.js";

export interface MusicResponderOptions {
  socket: SetSocket;
  selfUserId: string;
  environment: BotEnvironment;
  /**
   * Hands the Queue to the server, which gives it to everyone in the room. The
   * bot cannot emit to a room itself — it is an ordinary member — so this is a
   * request the server authorizes rather than a broadcast. See ADR-0005.
   */
  publish: (payload: { roomId: string; state: MusicQueueState }) => void;
  /** Re-read per Set: TURN credentials are short-lived and minted per user. */
  loadIceServers: () => Promise<IceServer[]>;
  createSet?: typeof createMusicSet;
  resolve?: typeof resolveTrack;
  fetch?: typeof fetchTrackAudio;
  /** Injected so a test does not have to match a UUID it cannot predict. */
  mintEntryId?: () => string;
  log?: (message: string) => void;
}

export interface MusicResponder {
  handle: (command: MusicCommand, roomId: string, requestedByUserId: string) => Promise<MusicCommandAck>;
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
  const mintEntryId = options.mintEntryId ?? (() => randomUUID());
  let set: MusicSet | null = null;
  let audio: TrackAudio | null = null;
  let playback: PlaybackState = emptyPlayback();
  let queue: Promise<void> = Promise.resolve();
  /**
   * The entry whose Track the player is holding, so that an end reported by the
   * player can name it. The player knows about audio and nothing about the
   * Queue, and by the time its report has waited its turn in the chain a skip
   * may already have moved on — in which case the end belongs to a Track that
   * is gone, and acting on it would drop the one that had just started.
   */
  let loadedEntryId: string | null = null;

  /**
   * Abandons the fetch behind whatever was playing. A Track that has been
   * replaced or stopped is a subprocess pair nobody is reading from any more,
   * and leaving them running would cost bandwidth for audio going nowhere.
   */
  function releaseAudio() {
    audio?.cancel();
    audio = null;
    loadedEntryId = null;
  }

  function publishTo(roomId: string) {
    options.publish({ roomId, state: publishedQueue(playback) });
  }

  /**
   * Carries out what the pure module decided. Nothing here makes a decision;
   * the order is the one it returned, and the order matters — `publish` comes
   * last on a change so the room is told about a Queue that is already true,
   * and comes before the Set is torn down so the bot is still a member of the
   * room it is publishing into.
   */
  function applyEffects(current: MusicSet, effects: PlaybackEffect[]) {
    for (const effect of effects) {
      switch (effect.kind) {
        case "load":
          startFetch(current, effect.entry);
          break;
        case "unload":
          releaseAudio();
          break;
        case "play":
          current.play();
          break;
        case "stop":
          current.stop();
          break;
        case "publish":
          publishTo(current.roomId);
          break;
        default:
          // Exhaustive: an effect added to the vocabulary should stop the build
          // rather than be silently dropped, which would look like the Queue
          // deciding something and nothing happening.
          assertNever(effect);
      }
    }
  }

  /**
   * Runs one event through the Queue and carries out the result.
   *
   * The fetch for the next Track starts here, when the previous one ended —
   * not before it. Prefetching would cost a second extractor run against a
   * source that rate-limits by address, for a Track that a skip or a removal
   * may mean nobody ever hears; and the gap it would close is the prebuffer
   * ADR-0004 already accepted as the price of starting early. By the code a
   * boundary should be silence rather than lost music, because the player
   * stalls instead of skipping ahead while the prebuffer fills — but nobody
   * has heard one yet, so how long that silence runs to is unmeasured.
   */
  function advance(current: MusicSet, event: PlaybackEvent) {
    const step = advancePlayback(playback, event);
    playback = step.state;
    applyEffects(current, step.effects);
    return step;
  }

  function startFetch(current: MusicSet, entry: QueueEntry) {
    const { track } = entry;
    releaseAudio();
    audio = fetchAudio(options.environment, track, log);
    loadedEntryId = entry.entryId;
    current.loadTrack(audio.buffer);
    log(`playing ${track.id} (${track.title}), ${track.durationSeconds}s`);
  }

  async function endCurrentSet() {
    const current = set;
    set = null;
    if (current) {
      // Before the membership goes, not after: a publish from a member the
      // server has already seen leave is a publish the server refuses, and the
      // room would be left holding the Queue of a Set that is over.
      advance(current, { kind: "cleared" });
      // Belt and braces. `cleared` returns `unload` for every Queue that had
      // anything in it, so this is normally a second call on an empty hand —
      // but the subprocess pair is this half's to own, and a Set that ended
      // while somehow still holding one would leak yt-dlp and ffmpeg for as
      // long as the process lives.
      releaseAudio();
      await current.end();
      return;
    }
    playback = emptyPlayback();
    releaseAudio();
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
      onTrackEnded: () => {
        // The Track the player was holding when it reached the end, named here
        // rather than read as "whatever is at the head now" — those are the
        // same entry only when nothing happened in between, and a skip landing
        // in that window is exactly what this has to survive.
        const ended = loadedEntryId;
        // Through the same chain as a command: a Track ending while a Summon is
        // half-finished must not advance a Queue that is still being changed.
        queue = queue.then(() => {
          if (set === started && ended) advance(started, { kind: "ended", entryId: ended });
        }).catch(() => undefined);
      },
      // Somebody arrived or left. Whoever just walked in has no Queue yet, and
      // the server keeps no copy to hand them, so the bot says it again. This
      // is what makes "everyone sees the same list" true for a member who
      // joined after the music started.
      onListenersChanged: () => {
        if (set === started) publishTo(roomId);
      },
      log
    });
    set = started;
    await started.begin();
    return started;
  }

  /**
   * A pasted link, from the paste to its place in the Queue.
   *
   * The order matters. The link is checked before anything is spawned, a full
   * Queue is refused before anything is spawned, and the Track is resolved
   * before the bot joins: a member who pasted something unplayable should get
   * told so without the bot appearing in the channel, playing nothing, and
   * having to be sent away again.
   */
  async function add(roomId: string, url: string, requestedByUserId: string): Promise<MusicCommandAck> {
    const canonical = youtubeVideoUrl(url);
    if (!canonical) return { ok: false, error: "unsupported_link" };
    // Only when this is the Queue the Track would join. A paste into a
    // *different* room summons the bot away, which ends that Set and takes its
    // Queue with it — so refusing on the strength of a Queue that is about to
    // stop existing would turn somebody else's full evening into this member's
    // refusal.
    if (set?.roomId === roomId) {
      const full = additionRefusal(playback);
      if (full) return { ok: false, error: full };
    }

    const resolved = await resolveDetails(options.environment, canonical);
    if (!resolved.ok) {
      log(`could not resolve ${canonical}: ${resolved.error}`);
      return resolved;
    }

    const current = await summon(roomId);
    const step = advance(current, {
      kind: "added",
      entry: { entryId: mintEntryId(), track: resolved.track, requestedByUserId }
    });
    if (step.refusal) return { ok: false, error: step.refusal };
    return { ok: true, track: summaryOf(resolved.track) };
  }

  async function apply(command: MusicCommand, roomId: string, requestedByUserId: string): Promise<MusicCommandAck> {
    if (command.kind === "add") return add(roomId, command.url, requestedByUserId);
    // The rest name the room they mean, so a command that raced a move does not
    // silence a Set the asker was never in. They are also about a Queue that is
    // already here: with nothing loaded there is nothing for them to do, and
    // that is a request that succeeded at doing nothing rather than a failure.
    if (!set || set.roomId !== roomId) return acknowledged;
    switch (command.kind) {
      case "play":
        advance(set, { kind: "resumed" });
        return acknowledged;
      case "stop":
        advance(set, { kind: "paused" });
        return acknowledged;
      // Both name the entry they mean rather than a position, and both succeed
      // when that entry has already gone. See ADR-0006: that is what makes two
      // members pressing skip together cost one Track rather than two, and it
      // is the Queue's rule, so it is decided in `playback.ts` and not here.
      case "skip":
        advance(set, { kind: "skipped", entryId: command.entryId });
        return acknowledged;
      case "remove":
        advance(set, { kind: "removed", entryId: command.entryId });
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
    handle(command, roomId, requestedByUserId) {
      const answered = queue.then(() => apply(command, roomId, requestedByUserId)).catch(async (cause: unknown) => {
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
