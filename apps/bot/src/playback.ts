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
  musicSetLogMaxLines,
  type MusicCommandAck,
  type MusicQueueState,
  type MusicSetLogAction,
  type MusicSetLogLine
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
  /**
   * What members have done to this Queue, most recent first and bounded.
   *
   * A line is written **only where the Queue is published**, which is what
   * keeps the log honest: a skip that named a Track the Queue had already
   * moved past changes nothing and tells the room nothing, and a line for it
   * would say a member skipped a Track that nobody skipped. So the rule is not
   * "every event writes a line" but "a change writes a line", and it falls out
   * of writing them in the branches that make the change.
   */
  readonly log: readonly MusicSetLogLine[];
  /**
   * Whether the room is empty and the bot is waiting for somebody to come back
   * — the Grace period, as far as a module with no clock can hold it.
   *
   * The five minutes are `music.ts`'s: this says only *that* a wait is on, and
   * it is what makes an expiry that arrives after somebody returned do nothing.
   * A clock cannot be unfired once it has gone off, so the answer is the same
   * one ADR-0006 gave a skip that named a Track the Queue had moved past: the
   * event is stale, the state says so, and the request changes nothing.
   *
   * It is not the whole guard, and it cannot be. Two waits in a row are the same
   * fact to this module; *which* wait an expiry belongs to is the clock's own
   * knowledge and stays with the clock.
   */
  readonly awaitingReturn: boolean;
}

/**
 * What a transition needs in order to write a line, and cannot work out for
 * itself.
 *
 * This module has no clock and no source of randomness — it performs no input
 * or output at all — so an identity for the line arrives on the event, exactly
 * as an `entryId` and a resolved Track already do. Who asked arrives the same
 * way: the bot is handed a user id with every request and this module is handed
 * it in turn.
 *
 * `added` is the one event that does not carry the member separately, because
 * its entry already names the Requester and one of the two would be the copy
 * that could disagree.
 */
interface LogContext {
  lineId: string;
  requestedByUserId: string;
}

/**
 * The line a transition writes, if any member asked for it. `null` where a
 * Track ended by itself: the log says who did something, and nobody did that.
 */
type LineToWrite = LogContext & { action: MusicSetLogAction };

export type PlaybackEvent =
  /** A member's link resolved to a Track and it goes on the end. */
  | { kind: "added"; entry: QueueEntry; lineId: string }
  /**
   * The Track that was playing reached its end of its own accord. It names the
   * entry that ended for the same reason a skip does: the player reports an end
   * for the Track it was handed, and by the time that arrives a skip may
   * already have moved past it. Acting on it then would drop the Track that had
   * just started.
   */
  | { kind: "ended"; entryId: string }
  /** A member asked to move past the Track they believe is playing. */
  | ({ kind: "skipped"; entryId: string } & LogContext)
  /** A member asked for one entry to leave the Queue, wherever it is in it. */
  | ({ kind: "removed"; entryId: string } & LogContext)
  | ({ kind: "paused" } & LogContext)
  | ({ kind: "resumed" } & LogContext)
  /**
   * The last Listener left, so the room now holds nobody but the bot.
   *
   * It names no member and writes no line, because nobody did anything to the
   * Queue: leaving a room is not an action on it, and there is no publish here
   * for a line to ride on (ADR-0008). Repeating it is the wait that is already
   * running rather than a second one — the roster hook reports every change,
   * including changes to a room that was empty before and after.
   */
  | { kind: "roomEmptied" }
  /**
   * Somebody is in the room again. The Queue is untouched and the music was
   * never stopped, so there is nothing to resume; what ends is the wait.
   *
   * Like its opposite, it is reported for every roster change rather than only
   * the interesting ones, so arriving at a room that already had people in it
   * is a Listener returning to a Grace period that was not running.
   */
  | { kind: "listenerReturned" }
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
  | { kind: "publish" }
  /**
   * Start waiting for somebody to come back, and end the Set if nobody does.
   *
   * The Grace period is the product's word for that wait (`CONTEXT.md`) and it
   * is what this effect is named after, rather than after the timer that will
   * carry it out — the same rule that makes `load` "fetch this Track" rather
   * than "spawn yt-dlp". How long five minutes is, and what runs it, is
   * `music.ts`'s business; this module has no clock.
   */
  | { kind: "startGracePeriod" }
  /** Somebody came back, or the Set ended. Nothing is being waited for now. */
  | { kind: "cancelGracePeriod" };

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
  return { entries: [], playing: false, log: [], awaitingReturn: false };
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
      return add(state, event.entry, event.lineId);
    case "ended":
      // A Track ending is the Queue advancing past it, with the player already
      // stopped of its own accord — which is the only thing that tells it apart
      // from a skip.
      return advancePast(state, event.entryId, { playerStillSounding: false, line: null });
    case "skipped":
      return advancePast(state, event.entryId, {
        playerStillSounding: state.playing,
        line: { ...event, action: "skipped" }
      });
    case "removed":
      return remove(state, event.entryId, { ...event, action: "removed" });
    case "paused":
      return pause(state, { ...event, action: "paused" });
    case "resumed":
      return resume(state, { ...event, action: "resumed" });
    case "roomEmptied":
      return startWaiting(state);
    case "listenerReturned":
      return stopWaiting(state);
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
    playing: state.playing,
    log: [...state.log]
  };
}

/**
 * Appending, not interrupting. The Track only starts if there was nothing in
 * front of it — which is the whole difference between a Queue and the single
 * slot this replaced.
 */
function add(state: PlaybackState, entry: QueueEntry, lineId: string): PlaybackStep {
  const refusal = additionRefusal(state);
  // Before the line is written, not after: a refused addition changes nothing,
  // and a log line for it would name a member for a Track that never joined the
  // Queue. The same rule as a stale skip, arrived at from the other direction.
  if (refusal) return { state, effects: [], refusal };
  const entries = [...state.entries, entry];
  const log = withLine(state.log, {
    lineId,
    action: "added",
    // The entry's own Requester rather than a second copy on the event: one of
    // the two would be the one that could disagree with the Queue row.
    requestedByUserId: entry.requestedByUserId,
    trackTitle: entry.track.title
  });
  if (state.entries.length > 0) {
    // Something is already at the head of the Queue, playing or paused. Adding
    // behind it touches nothing but the list.
    return {
      state: { entries, playing: state.playing, log, awaitingReturn: state.awaitingReturn },
      effects: [{ kind: "publish" }]
    };
  }
  return {
    state: { entries, playing: true, log, awaitingReturn: state.awaitingReturn },
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
  options: { playerStillSounding: boolean; line: LineToWrite | null }
): PlaybackStep {
  const head = state.entries[0];
  // Everything below this line is a change the room will be told about, so
  // everything below it may write to the log. Nothing above it may: a request
  // that arrived too late is a request that took nothing away.
  if (head?.entryId !== entryId) return { state, effects: [] };
  const entries = state.entries.slice(1);
  const log = options.line ? withLine(state.log, lineFor(options.line, head.track.title)) : state.log;
  const next = entries[0];
  // Only when something is really being taken away mid-flight. A Track that
  // ended of its own accord left the player stopped already, and a paused Queue
  // has nothing sounding to stop.
  const silence: PlaybackEffect[] = options.playerStillSounding ? [{ kind: "stop" }] : [];
  if (!next) {
    return {
      state: { entries, playing: false, log, awaitingReturn: state.awaitingReturn },
      effects: [...silence, { kind: "unload" }, { kind: "publish" }]
    };
  }
  return {
    state: { entries, playing: state.playing, log, awaitingReturn: state.awaitingReturn },
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
function remove(state: PlaybackState, entryId: string, line: LineToWrite): PlaybackStep {
  const index = state.entries.findIndex((item) => item.entryId === entryId);
  if (index < 0) return { state, effects: [] };
  // The line says `removed` either way. Taking the head out is skipping it as
  // far as the player is concerned, which is why it is one rule and not two —
  // but they are two things a member did, and telling them apart in the log is
  // the reason ADR-0006 kept them as two verbs.
  if (index === 0) return advancePast(state, entryId, { playerStillSounding: state.playing, line });
  const removed = state.entries[index]!;
  const entries = [...state.entries.slice(0, index), ...state.entries.slice(index + 1)];
  return {
    state: {
      entries,
      playing: state.playing,
      log: withLine(state.log, lineFor(line, removed.track.title)),
      awaitingReturn: state.awaitingReturn
    },
    effects: [{ kind: "publish" }]
  };
}

function pause(state: PlaybackState, line: LineToWrite): PlaybackStep {
  // A pause arriving at a Queue that is already stopped changes nothing, so it
  // publishes nothing and writes nothing. A line for it would name a member for
  // a silence that was already there.
  if (!state.playing) return { state, effects: [] };
  return {
    // No Track on the line: a pause is about the Queue rather than about any
    // one Track, and the Track it stopped is still at the head of the list
    // where the panel is already calling it paused.
    state: {
      entries: state.entries,
      playing: false,
      log: withLine(state.log, lineFor(line, null)),
      awaitingReturn: state.awaitingReturn
    },
    effects: [{ kind: "stop" }, { kind: "publish" }]
  };
}

/**
 * Resuming plays what is already loaded. There is no `load` here on purpose: a
 * pause did not abandon the fetch, so the audio is still in memory and asking
 * for it again would be a second trip to the source for something the bot is
 * already holding.
 */
function resume(state: PlaybackState, line: LineToWrite): PlaybackStep {
  if (state.playing || state.entries.length === 0) return { state, effects: [] };
  return {
    state: {
      entries: state.entries,
      playing: true,
      log: withLine(state.log, lineFor(line, null)),
      awaitingReturn: state.awaitingReturn
    },
    effects: [{ kind: "play" }, { kind: "publish" }]
  };
}

/**
 * Nobody is left in the room, so the bot waits rather than leaving at once. A
 * page refresh takes a member out of the voice room for a second or two, and
 * the Queue should survive that — which is the whole reason the Grace period
 * exists (`CONTEXT.md`).
 *
 * **Nothing is paused and nothing is published.** Not paused, because a member
 * who comes back inside the wait should find the music *continuing* rather than
 * needing to be restarted, and the Queue does not know the difference between
 * five seconds and five minutes. Not published, because the Queue did not
 * change and there is nobody there to be told about it.
 *
 * A second emptying is the wait that is already running. The hook that produces
 * this reports every roster change, and a room with nobody in it can still
 * report one; restarting the clock on each would let an empty room hold the bot
 * for as long as anything at all kept moving.
 */
function startWaiting(state: PlaybackState): PlaybackStep {
  if (state.awaitingReturn) return { state, effects: [] };
  return {
    state: { entries: state.entries, playing: state.playing, log: state.log, awaitingReturn: true },
    effects: [{ kind: "startGracePeriod" }]
  };
}

/**
 * Somebody is in the room again, so there is nothing left to wait for.
 *
 * There is deliberately no `play` here. The music was never stopped, so a
 * member who left and came back finds the Track where it got to — and a member
 * who *paused* it before the room emptied must not have it started again by
 * somebody walking in. What is playing is nobody's to change by arriving; that
 * is ADR-0006 §4's rule, said about a Listener instead of about a Queue.
 */
function stopWaiting(state: PlaybackState): PlaybackStep {
  if (!state.awaitingReturn) return { state, effects: [] };
  return {
    state: { entries: state.entries, playing: state.playing, log: state.log, awaitingReturn: false },
    effects: [{ kind: "cancelGracePeriod" }]
  };
}

/**
 * The order matters to the caller: the room is told the Queue is empty while
 * the bot is still in it. Publishing after the Set has torn down would be a
 * message from a member who has left, which the server refuses — correctly.
 */
function clear(state: PlaybackState): PlaybackStep {
  // The wait goes with the Set, whatever ended it — an eviction, a Summon into
  // another room, or the Grace period running out. In every case there is no
  // room left to wait in, and a clock still running would end a Set that no
  // longer exists.
  const stopTheClock: PlaybackEffect[] = state.awaitingReturn ? [{ kind: "cancelGracePeriod" }] : [];
  // The log counts as something to discard. A Set whose Tracks have all played
  // out has an empty Queue and a full log, and saying nothing here would leave
  // that log standing on five panels for a Set that is over.
  if (state.entries.length === 0 && !state.playing && state.log.length === 0) {
    return { state: emptyPlayback(), effects: stopTheClock };
  }
  return {
    state: emptyPlayback(),
    effects: [...stopTheClock, { kind: "stop" }, { kind: "unload" }, { kind: "publish" }]
  };
}

/**
 * The newest line on the front, and the oldest off the back once there are
 * `musicSetLogMaxLines` of them.
 *
 * Most recent first because the log's whole job is to explain what just
 * happened, and the panel it renders into owns no scroll region — so the line
 * that answers "why did the music change" has to be at the top, where a member
 * is already looking, rather than at the bottom of a block that grows down the
 * page every time somebody else presses a button.
 *
 * Dropping the oldest rather than refusing the newest, which is the opposite of
 * what a full Queue does. A Queue is a promise about what will play, so the
 * member who would lose their Track is told; a log is a record of what already
 * happened, and the thing worth keeping when there is not room for all of it is
 * the most recent part.
 */
function withLine(log: readonly MusicSetLogLine[], line: MusicSetLogLine): MusicSetLogLine[] {
  return [line, ...log].slice(0, musicSetLogMaxLines);
}

/** The Track by its title, because the entry it names is on its way out. */
function lineFor(line: LineToWrite, trackTitle: string | null): MusicSetLogLine {
  return {
    lineId: line.lineId,
    action: line.action,
    requestedByUserId: line.requestedByUserId,
    trackTitle
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled playback event: ${JSON.stringify(value)}`);
}
