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
  /** The Track that was playing reached its end of its own accord. */
  | { kind: "ended" }
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
  /** Fetch this Track and load it, replacing whatever was loaded before. */
  | { kind: "load"; track: Track }
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
      return end(state);
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
    effects: [{ kind: "load", track: entry.track }, { kind: "play" }, { kind: "publish" }]
  };
}

function end(state: PlaybackState): PlaybackStep {
  if (state.entries.length === 0) return { state, effects: [] };
  const entries = state.entries.slice(1);
  const next = entries[0];
  if (!next) {
    return { state: { entries, playing: false }, effects: [{ kind: "unload" }, { kind: "publish" }] };
  }
  return {
    state: { entries, playing: true },
    effects: [{ kind: "load", track: next.track }, { kind: "play" }, { kind: "publish" }]
  };
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
