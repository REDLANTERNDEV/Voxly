/**
 * What the Music bot is playing and what it will play next.
 *
 * This is the feature's primary test seam, and it is pure on purpose: a state
 * and one event go in, the next state and a list of effects come out. It reads
 * nothing, writes nothing, spawns nothing and waits for nothing. Every rule the
 * Queue has — that adding while something plays appends rather than interrupts,
 * that a Track ending advances to the next, that pausing does not lose the list
 * — is decided here and can be asserted without a socket or a subprocess.
 *
 * `music.ts` is the imperative half. It turns a request into an event, runs it
 * through here, and carries out whatever comes back: fetching, playing,
 * stopping, and telling the room. Nothing in this module knows any of those
 * things exist.
 *
 * The Queue belongs to a Set. It is built in memory, it is not written down,
 * and it goes when the Set does — which is what the design chose, because a
 * redeploy interrupts voice anyway.
 */

import {
  musicQueueMaxEntries,
  type MusicCommandAck,
  type MusicQueueState
} from "@voxly/shared";
import type { Track } from "./track.js";

/**
 * One Track in the Queue and who put it there. The Requester is a user id;
 * ADR-0005 records why the name is resolved at the browser's end instead.
 */
export interface QueueEntry {
  /**
   * This entry, as distinct from the Track it names. Two members queueing the
   * same link are two entries, and either can be skipped or removed without
   * taking the other with it.
   */
  entryId: string;
  track: Track;
  requestedByUserId: string;
}

export interface PlaybackState {
  /** In playing order. `entries[0]` is the one playing or paused. */
  readonly entries: readonly QueueEntry[];
  /** Whether `entries[0]` is sounding right now. A paused Queue is not empty. */
  readonly playing: boolean;
}

export type PlaybackEvent =
  /** A member's link resolved to a Track and it goes on the end. */
  | { kind: "added"; entry: QueueEntry }
  /**
   * The Track that was playing reached its end of its own accord. It names the
   * entry that ended for the same reason a skip does: the player reports an end
   * for the Track it was handed, and by the time that arrives a skip may
   * already have moved past it. Acting on it then would drop the Track that had
   * just started.
   */
  | { kind: "ended"; entryId: string }
  /** A member asked to move past the Track they believe is playing. */
  | { kind: "skipped"; entryId: string }
  /** A member asked for one entry to leave the Queue, wherever it is in it. */
  | { kind: "removed"; entryId: string }
  | { kind: "paused" }
  | { kind: "resumed" }
  /** The Set is over: the Queue is discarded and nothing survives it. */
  | { kind: "cleared" };

/**
 * What somebody else has to do about the transition. Deliberately small and
 * deliberately about the product rather than the library: `load` is "this Track
 * should be fetched and handed to the player", not "spawn yt-dlp", so swapping
 * the media path leaves this vocabulary alone.
 */
export type PlaybackEffect =
  /**
   * Fetch this entry's Track and load it, replacing whatever was loaded before.
   * The whole entry rather than its Track, because the imperative half has to be
   * able to say *which* entry ended when the player reports an end — and a Track
   * cannot say that, two members queueing the same link being two entries.
   */
  | { kind: "load"; entry: QueueEntry }
  /** Abandon the fetch behind whatever was loaded. Nothing is loaded now. */
  | { kind: "unload" }
  | { kind: "play" }
  | { kind: "stop" }
  /** Tell everyone in the room what the Queue now is. */
  | { kind: "publish" };

/** Why an event was refused. The member who asked is owed this sentence. */
export type PlaybackRefusal = Extract<MusicCommandAck, { ok: false }>["error"];

export interface PlaybackStep {
  state: PlaybackState;
  effects: PlaybackEffect[];
  /**
   * Present only when the event was refused, in which case `state` is the state
   * that came in and `effects` is empty. A refusal is an answer, not a fault.
   */
  refusal?: PlaybackRefusal;
}

export function emptyPlayback(): PlaybackState {
  return { entries: [], playing: false };
}

/**
 * Why the next addition would be refused, if it would.
 *
 * Exported so the imperative half can ask *before* it spends a link on the
 * extractor: a full Queue is knowable without fetching anything, and spawning a
 * subprocess to produce a Track that is then thrown away is a round trip to
 * somebody else's servers for nothing. `advancePlayback` applies the same rule,
 * so there is one bound rather than two that can drift.
 */
export function additionRefusal(state: PlaybackState): PlaybackRefusal | null {
  return state.entries.length >= musicQueueMaxEntries ? "queue_full" : null;
}

/**
 * One event against one state.
 *
 * Every branch returns a fresh state rather than mutating the one it was given,
 * so a caller holding the previous state — a test asserting that a refusal
 * changed nothing, for instance — still holds what it had.
 */
export function advancePlayback(state: PlaybackState, event: PlaybackEvent): PlaybackStep {
  switch (event.kind) {
    case "added":
      return add(state, event.entry);
    case "ended":
      // A Track ending is the Queue advancing past it, with the player already
      // stopped of its own accord — which is the only thing that tells it apart
      // from a skip.
      return advancePast(state, event.entryId, { playerStillSounding: false });
    case "skipped":
      return advancePast(state, event.entryId, { playerStillSounding: state.playing });
    case "removed":
      return remove(state, event.entryId);
    case "paused":
      return pause(state);
    case "resumed":
      return resume(state);
    case "cleared":
      return clear(state);
    default:
      // Exhaustive rather than a catch-all: an event added to the vocabulary
      // should stop the build here rather than silently do whatever the last
      // branch happened to do.
      return assertNever(event);
  }
}

/**
 * The Queue as everyone outside this process sees it. The bot's own knowledge
 * of a Track — the URL it would fetch again — does not travel with it.
 */
export function publishedQueue(state: PlaybackState): MusicQueueState {
  return {
    entries: state.entries.map((item) => ({
      entryId: item.entryId,
      requestedByUserId: item.requestedByUserId,
      track: {
        id: item.track.id,
        title: item.track.title,
        durationSeconds: item.track.durationSeconds
      }
    })),
    playing: state.playing
  };
}

/**
 * Appending, not interrupting. The Track only starts if there was nothing in
 * front of it — which is the whole difference between a Queue and the single
 * slot this replaced.
 */
function add(state: PlaybackState, entry: QueueEntry): PlaybackStep {
  const refusal = additionRefusal(state);
  if (refusal) return { state, effects: [], refusal };
  const entries = [...state.entries, entry];
  if (state.entries.length > 0) {
    // Something is already at the head of the Queue, playing or paused. Adding
    // behind it touches nothing but the list.
    return { state: { entries, playing: state.playing }, effects: [{ kind: "publish" }] };
  }
  return {
    state: { entries, playing: true },
    effects: [{ kind: "load", entry }, { kind: "play" }, { kind: "publish" }]
  };
}

/**
 * Move past the Track at the head, if that is still the Track being named.
 *
 * The targeting is the whole answer to two members pressing skip at the same
 * moment, and it needs no lock and no sequence number: the second request
 * arrives to find that the Track it named is not at the head any more, and
 * doing nothing is exactly right — the member asked for that Track to stop
 * playing, and it has. So it succeeds, silently, and the Queue does not move
 * twice for one intention.
 *
 * It is also why nothing is refused here. A refusal would put a sentence in
 * front of somebody who got what they wanted, and the room is told nothing
 * because nothing changed, which leaves every client showing what the bot
 * shows.
 *
 * `playing` survives the move. Skipping says *which Track*, not *whether to
 * play*: somebody who paused the music to talk should not have the next one
 * start under them. The next Track is still loaded, though, so resuming plays
 * it rather than replaying the one that was skipped.
 */
function advancePast(
  state: PlaybackState,
  entryId: string,
  options: { playerStillSounding: boolean }
): PlaybackStep {
  if (state.entries[0]?.entryId !== entryId) return { state, effects: [] };
  const entries = state.entries.slice(1);
  const next = entries[0];
  // Only when something is really being taken away mid-flight. A Track that
  // ended of its own accord left the player stopped already, and a paused Queue
  // has nothing sounding to stop.
  const silence: PlaybackEffect[] = options.playerStillSounding ? [{ kind: "stop" }] : [];
  if (!next) {
    return {
      state: { entries, playing: false },
      effects: [...silence, { kind: "unload" }, { kind: "publish" }]
    };
  }
  return {
    state: { entries, playing: state.playing },
    effects: [
      { kind: "load", entry: next },
      ...(state.playing ? [{ kind: "play" } as const] : []),
      { kind: "publish" }
    ]
  };
}

/**
 * Take one entry out, wherever it is in the Queue.
 *
 * Removing the head is skipping it — the Track being taken away is the one
 * sounding, so the Queue has to move on — and that is one rule rather than two
 * that could disagree. Removing anything else touches the list and nothing
 * else: the player is not disturbed by a change happening behind it.
 *
 * An entry the Queue no longer holds is not an error, for the same reason a
 * late skip is not: the member wanted it gone and it is gone.
 */
function remove(state: PlaybackState, entryId: string): PlaybackStep {
  const index = state.entries.findIndex((item) => item.entryId === entryId);
  if (index < 0) return { state, effects: [] };
  if (index === 0) return advancePast(state, entryId, { playerStillSounding: state.playing });
  const entries = [...state.entries.slice(0, index), ...state.entries.slice(index + 1)];
  return { state: { entries, playing: state.playing }, effects: [{ kind: "publish" }] };
}

function pause(state: PlaybackState): PlaybackStep {
  if (!state.playing) return { state, effects: [] };
  return { state: { entries: state.entries, playing: false }, effects: [{ kind: "stop" }, { kind: "publish" }] };
}

/**
 * Resuming plays what is already loaded. There is no `load` here on purpose: a
 * pause did not abandon the fetch, so the audio is still in memory and asking
 * for it again would be a second trip to the source for something the bot is
 * already holding.
 */
function resume(state: PlaybackState): PlaybackStep {
  if (state.playing || state.entries.length === 0) return { state, effects: [] };
  return { state: { entries: state.entries, playing: true }, effects: [{ kind: "play" }, { kind: "publish" }] };
}

/**
 * The order matters to the caller: the room is told the Queue is empty while
 * the bot is still in it. Publishing after the Set has torn down would be a
 * message from a member who has left, which the server refuses — correctly.
 */
function clear(state: PlaybackState): PlaybackStep {
  if (state.entries.length === 0 && !state.playing) return { state, effects: [] };
  return {
    state: emptyPlayback(),
    effects: [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled playback event: ${JSON.stringify(value)}`);
}
