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
 * halfway through a command that was already changing the Queue. Searches have
 * a chain of their own: they change nothing, so making one wait for a Summon
 * would only mean a Skip waiting behind somebody else's typing — but they do
 * still spawn an extractor, so they take their turn among themselves
 * (ADR-0007).
 *
 * Every request is answered. The answer travels back through the server to the
 * member who made it, because only this process can tell whether a pasted link
 * is something it can play, and a member who pasted a dead one is owed a
 * sentence rather than a room where nothing happens. It also travels back
 * *only* to them: a member's search results are the one thing here that is not
 * the room's to see.
 */

import { randomUUID } from "node:crypto";
import type {
  MusicCommand,
  MusicCommandAck,
  MusicQueueState,
  MusicTrackFailure,
  VoiceForceLeaveReason
} from "@voxly/shared";
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
import { fetchTrackAudio, resolveTrack, searchTracks, type TrackAudio } from "./stream.js";
import { resolverFor, type Track } from "./track.js";
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
  search?: typeof searchTracks;
  fetch?: typeof fetchTrackAudio;
  /** Injected so a test does not have to match a UUID it cannot predict. */
  mintEntryId?: () => string;
  /**
   * The same, for a Set log line. Two minters rather than one shared counter
   * because a test that names an entry and a test that names a line would
   * otherwise be reading the same sequence with holes punched in it — and which
   * ids an addition consumes would become something every unrelated test had to
   * know. In the process both are `randomUUID`.
   */
  mintLineId?: () => string;
  /**
   * The Grace period's clock, injected for the same reason the player's
   * interval is: a test that waited five real minutes out is a test nobody
   * runs. Nothing else in this module measures time.
   */
  setTimeout?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  log?: (message: string) => void;
}

export interface MusicResponder {
  handle: (command: MusicCommand, roomId: string, requestedByUserId: string) => Promise<MusicCommandAck>;
  /** Ends any Set in progress. Used when the connection goes away. */
  close: () => Promise<void>;
  currentRoomId: () => string | null;
}

/** Nothing to report: the request either worked or was about no Track at all. */
const acknowledged: MusicCommandAck = { ok: true, kind: "track", track: null };

/**
 * How long the bot waits in a room the last Listener has left before giving up
 * on them and ending the Set.
 *
 * The clock is here rather than in `playback.ts` because that module performs
 * no input or output and has no way to measure five minutes; what it holds is
 * the rule, and this is the wait the rule asks for. Five minutes is the design's
 * number and the reason is a page refresh: reloading takes a member out of the
 * voice room for a second or two, and an evening's Queue should not be
 * destroyed by one. Long enough to cover a reload, a browser restart or a
 * dropped connection somebody comes straight back from; short enough that a bot
 * nobody wants is gone before anyone thinks to send it away.
 */
export const gracePeriodMs = 5 * 60 * 1000;

export function createMusicResponder(options: MusicResponderOptions): MusicResponder {
  const log = options.log ?? (() => undefined);
  const createSet = options.createSet ?? createMusicSet;
  const resolveDetails = options.resolve ?? resolveTrack;
  const searchSource = options.search ?? searchTracks;
  // Not named `fetch`: the global of that name is a very different thing to
  // find shadowed halfway down a file.
  const fetchAudio = options.fetch ?? fetchTrackAudio;
  const mintEntryId = options.mintEntryId ?? (() => randomUUID());
  const mintLineId = options.mintLineId ?? (() => randomUUID());
  const startTimer = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const stopTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
  let set: MusicSet | null = null;
  let audio: TrackAudio | null = null;
  let playback: PlaybackState = emptyPlayback();
  let queue: Promise<void> = Promise.resolve();
  /**
   * Searches take their turn among themselves, and nowhere near the chain
   * above.
   *
   * Separate because a search changes nothing, so it has no reason to wait for
   * a Summon and a Skip has no reason to wait for it. Serialised because it
   * still spawns an extractor, and the one thing this feature has always
   * refused to do is run two of those at once against a source that rate-limits
   * by address — it is the reason nothing is prefetched. One chain each keeps
   * both properties instead of trading one for the other.
   */
  let searches: Promise<void> = Promise.resolve();
  /**
   * The entry whose Track the player is holding, so that an end reported by the
   * player can name it. The player knows about audio and nothing about the
   * Queue, and by the time its report has waited its turn in the chain a skip
   * may already have moved on — in which case the end belongs to a Track that
   * is gone, and acting on it would drop the one that had just started.
   */
  let loadedEntryId: string | null = null;
  /** The Grace period's timer, while one is running. See `startGracePeriod`. */
  let graceTimer: NodeJS.Timeout | null = null;
  /**
   * How many waits this Set has started, which is how an expiry says which wait
   * it belongs to. Counted rather than named because nothing outside this
   * closure ever sees it — it is not the per-Set sequence number ADR-0006
   * rejected, which was a number a *client* echoed back over the wire.
   */
  let graceWaitsStarted = 0;

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
        case "startGracePeriod":
          startGracePeriod(current);
          break;
        case "cancelGracePeriod":
          cancelGracePeriod();
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

  /**
   * Waits the Grace period out, and ends the Set if nobody comes back.
   *
   * The expiry goes through the same chain as a command, for the same reason a
   * Track ending does: ending a Set is several round trips and must not land
   * halfway through a Summon that is already running.
   *
   * It then asks three questions before doing anything, and none of them
   * implies another. `clearTimeout` cannot un-fire a callback the runtime has
   * already picked up, so an expiry really can arrive after the wait it belongs
   * to stopped being the wait — three different ways:
   *
   * - **The Set was replaced**, by a Summon into another room. This expiry
   *   belongs to a Set that is already over, and ending the new room's would
   *   cost it its music.
   * - **A Listener came back.** The wait was cancelled; the Queue's own state
   *   says so, which is ADR-0006's rule for a stale skip said about a wait
   *   instead of about an entry.
   * - **They came back and left again.** The Queue says a wait is on, and it is
   *   right — but it is the *second* wait's, with nearly all five minutes still
   *   to run, and this expiry would cut it short. Nothing about the Queue's
   *   state can tell the two apart, because both are "a wait is on"; which wait
   *   is the clock's own knowledge, so the clock counts them.
   */
  function startGracePeriod(current: MusicSet) {
    cancelGracePeriod();
    const wait = (graceWaitsStarted += 1);
    log(`the last Listener left room ${current.roomId}; waiting ${gracePeriodMs}ms before leaving.`);
    graceTimer = startTimer(() => {
      queue = queue.then(async () => {
        if (set !== current || wait !== graceWaitsStarted || !playback.awaitingReturn) return;
        log(`nobody came back to room ${current.roomId}; ending the Set.`);
        await endCurrentSet();
      }).catch(() => undefined);
    }, gracePeriodMs);
  }

  /**
   * Stops the clock. Safe on one that has already gone off — clearing a fired
   * timer does nothing, and the expiry it left in the chain is stopped by the
   * questions above rather than from here.
   */
  function cancelGracePeriod() {
    if (graceTimer === null) return;
    stopTimer(graceTimer);
    graceTimer = null;
  }

  function startFetch(current: MusicSet, entry: QueueEntry) {
    const { track } = entry;
    releaseAudio();
    audio = fetchAudio(options.environment, track, {
      log,
      onFailure: (failure) => reportFailure(current, entry.entryId, failure)
    });
    loadedEntryId = entry.entryId;
    current.loadTrack(audio.buffer);
    log(`playing ${track.id} (${track.title}), ${track.durationSeconds}s`);
  }

  /**
   * A Track that resolved an hour ago and will not play now.
   *
   * The Set moving on is what tears a fetch down, so this only ever arrives for
   * a fetch that really gave up — `cancel` reports nothing. It still names the
   * entry rather than "whatever is playing", for the same reason an end does: a
   * skip can reach the Queue first, and a failure about a Track the room has
   * already left behind must change nothing (ADR-0006).
   *
   * Through the same chain as a command, so it cannot land halfway through a
   * Summon that is already running — and so that it is ahead of the end the
   * player is about to report for the same Track, which `stream.ts` guarantees
   * by reporting before it closes the buffer.
   */
  function reportFailure(current: MusicSet, entryId: string, failure: MusicTrackFailure) {
    queue = queue.then(() => {
      if (set !== current) return;
      advance(current, { kind: "failed", entryId, reason: failure, lineId: mintLineId() });
    }).catch(() => undefined);
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
      onListenersChanged: (listenerUserIds) => {
        if (set !== started) return;
        publishTo(roomId);
        // The bot is not in this list — a Set takes itself out of the roster
        // before reporting — so an empty one is a room holding nobody but the
        // bot, and that is what starts the Grace period. One of the two is sent
        // on every roster change rather than only on the interesting ones,
        // because which of them is news is the Queue's to answer: both are
        // idempotent there, and holding a second copy of "is a wait on" here
        // would be the copy that could disagree with it.
        advance(started, listenerUserIds.length === 0
          ? { kind: "roomEmptied" }
          : { kind: "listenerReturned" });
      },
      log
    });
    set = started;
    await started.begin();
    return started;
  }

  /**
   * A link, from the paste to its place in the Queue.
   *
   * The order matters. A full Queue is refused before anything is spawned, and
   * the Track is resolved before the bot joins: a member who pasted something
   * unplayable should get told so without the bot appearing in the channel,
   * playing nothing, and having to be sent away again.
   *
   * The link arrives already canonical, because deciding whether a member typed
   * a link or a name is the same question as which link they meant, and it is
   * asked once, in `handle`.
   */
  async function add(roomId: string, url: string, requestedByUserId: string): Promise<MusicCommandAck> {
    // Only when this is the Queue the Track would join. A paste into a
    // *different* room summons the bot away, which ends that Set and takes its
    // Queue with it — so refusing on the strength of a Queue that is about to
    // stop existing would turn somebody else's full evening into this member's
    // refusal.
    if (set?.roomId === roomId) {
      const full = additionRefusal(playback);
      if (full) return { ok: false, error: full };
    }

    const resolved = await resolveDetails(options.environment, url);
    if (!resolved.ok) {
      log(`could not resolve ${url}: ${resolved.error}`);
      return resolved;
    }

    const current = await summon(roomId);
    const step = advance(current, {
      kind: "added",
      entry: { entryId: mintEntryId(), track: resolved.track, requestedByUserId },
      lineId: mintLineId()
    });
    if (step.refusal) return { ok: false, error: step.refusal };
    return { ok: true, kind: "track", track: summaryOf(resolved.track) };
  }

  /**
   * A typed name, answered with the Tracks it might have meant.
   *
   * **This touches nothing.** No Set, no Queue, no membership — a member asking
   * what a name might mean has not asked for the bot to appear anywhere, and
   * summoning it would take it out of whichever room it is currently playing
   * in. That is also why the answer goes back to the one socket that asked and
   * is never published: the Queue is the room's and everyone must see the same
   * one, while a list of Results belongs to the member still deciding.
   *
   * A search that matched nothing is a success carrying an empty list. Nothing
   * failed, and there is nothing here for a member to wait out.
   */
  async function runSearch(name: string): Promise<MusicCommandAck> {
    const found = await searchSource(options.environment, name).catch((cause: unknown) => {
      // Not the extractor's fault by default: a fault in this process would
      // otherwise send the member away to wait for a source that never refused
      // them.
      log(`the search for "${name}" failed: ${String(cause)}`);
      return { ok: false, error: "bot_failed" } as const;
    });
    if (!found.ok) {
      log(`could not search for "${name}": ${found.error}`);
      return found;
    }
    return { ok: true, kind: "results", results: found.results };
  }

  /**
   * One search at a time, and never behind a Summon.
   *
   * The chain never rejects, because `runSearch` has already turned every
   * failure into an answer — and it must not tear anything down when one does:
   * the Set chain's recovery ends the Set, which would cost a room its music
   * because somebody mistyped a name.
   */
  function enqueueSearch(name: string): Promise<MusicCommandAck> {
    const answered = searches.then(() => runSearch(name));
    searches = answered.then(() => undefined, () => undefined);
    return answered;
  }

  async function apply(
    command: Exclude<MusicCommand, { kind: "add" }>,
    roomId: string,
    requestedByUserId: string
  ): Promise<MusicCommandAck> {
    // These name the room they mean, so a command that raced a move does not
    // silence a Set the asker was never in. They are also about a Queue that is
    // already here: with nothing loaded there is nothing for them to do, and
    // that is a request that succeeded at doing nothing rather than a failure.
    if (!set || set.roomId !== roomId) return acknowledged;
    switch (command.kind) {
      case "play":
        advance(set, { kind: "resumed", requestedByUserId, lineId: mintLineId() });
        return acknowledged;
      case "stop":
        advance(set, { kind: "paused", requestedByUserId, lineId: mintLineId() });
        return acknowledged;
      // Both name the entry they mean rather than a position, and both succeed
      // when that entry has already gone. See ADR-0006: that is what makes two
      // members pressing skip together cost one Track rather than two, and it
      // is the Queue's rule, so it is decided in `playback.ts` and not here.
      case "skip":
        advance(set, { kind: "skipped", entryId: command.entryId, requestedByUserId, lineId: mintLineId() });
        return acknowledged;
      case "remove":
        advance(set, { kind: "removed", entryId: command.entryId, requestedByUserId, lineId: mintLineId() });
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

  /**
   * Puts one request through the chain and answers it whatever happens.
   *
   * Everything that can change the Set goes through here, one at a time. The
   * recovery is part of the reason: a request that threw may have left a
   * half-built Set behind, and the next one must not trip over it.
   */
  function enqueue(
    what: string,
    roomId: string,
    run: () => Promise<MusicCommandAck>
  ): Promise<MusicCommandAck> {
    const answered = queue.then(run).catch(async (cause: unknown) => {
      // A failed Summon must not take the process down, and must not leave a
      // half-built Set behind for the next command to trip over.
      log(`the ${what} request for room ${roomId} failed: ${String(cause)}`);
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
  }

  return {
    /**
     * Which resolver a member's input is for is decided here, once, because it
     * decides which path the request takes as well as what it means.
     *
     * A search is the one request that does not join *this* chain. It changes
     * nothing — it has no Set to race and no membership to own — so making it
     * wait behind a Summon would only mean that a member who typed a name is
     * held up by somebody else's join, and, worse, that a Skip sits behind ten
     * seconds of somebody else's search. It stays out of the chain's recovery
     * for the same reason: that recovery ends the Set, which is the right
     * answer to a Summon that failed halfway and a catastrophic one to a search
     * that did. It has a chain of its own instead, because a search still
     * spawns an extractor and two of those at once is the one thing this
     * feature has always refused.
     */
    handle(command, roomId, requestedByUserId) {
      if (command.kind !== "add") {
        return enqueue(command.kind, roomId, () => apply(command, roomId, requestedByUserId));
      }
      const choice = resolverFor(command.input);
      switch (choice.kind) {
        case "search":
          return enqueueSearch(choice.name);
        // A link to something this bot cannot play — a playlist, a channel,
        // another site. Refused without spawning anything and without the bot
        // appearing in the channel to say so.
        case "unsupported":
          return Promise.resolve({ ok: false, error: "unsupported_link" });
        // Neither a link nor a name. Answered as a search that found nothing,
        // which is what it is, rather than as a wrong link — and without
        // spending a process on asking the source about no characters.
        case "nothing":
          return Promise.resolve({ ok: true, kind: "results", results: [] });
        case "link":
          return enqueue(command.kind, roomId, () => add(roomId, choice.url, requestedByUserId));
        default:
          // Exhaustive, as the effect and command switches here are: a resolver
          // added to the vocabulary should stop the build rather than fall into
          // whichever branch happened to be last and queue the wrong thing.
          return Promise.resolve(assertNever(choice));
      }
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
  throw new Error(`Unhandled music command or resolver: ${JSON.stringify(value)}`);
}
