import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { musicQueueMaxEntries, musicSetLogMaxLines } from "@voxly/shared";
import {
  advancePlayback,
  emptyPlayback,
  publishedQueue,
  type PlaybackEffect,
  type PlaybackEvent,
  type PlaybackState,
  type QueueEntry
} from "../src/playback.js";
import type { Track } from "../src/track.js";

/**
 * The design's primary test seam. Every rule the Queue has is asserted here,
 * without a socket, a subprocess or a peer connection — because the module has
 * none of those. It takes a state and one event and answers with the next state
 * and the effects somebody else has to perform.
 */

function trackFor(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    durationSeconds: 273,
    url: `https://www.youtube.com/watch?v=${id}`
  };
}

/**
 * `entryId` is minted per addition, not derived from the Track — which is what
 * `music.ts` does too, and what makes two people queueing the same link two
 * entries rather than one.
 */
let minted = 0;
function entry(id: string, requestedByUserId = "ada"): QueueEntry {
  minted += 1;
  return { entryId: `entry-${minted}`, track: trackFor(id), requestedByUserId };
}

/**
 * The identity a Set log line needs and the pure module cannot mint. It arrives
 * on the event exactly as an `entryId` and a resolved Track already do; a
 * counter here so a test can name the line it means.
 */
let lines = 0;
const nextLineId = () => `line-${(lines += 1)}`;

const added = (id: string, requestedByUserId?: string): PlaybackEvent =>
  ({ kind: "added", entry: entry(id, requestedByUserId), lineId: nextLineId() });
/**
 * Written as thunks so a run of events can pause twice and get two lines, and
 * so a test that cares who pressed the button can say. `run` calls anything it
 * is handed as a function, so `paused` still reads as an event in a list.
 */
const pausedBy = (requestedByUserId = "ada"): PlaybackEvent =>
  ({ kind: "paused", requestedByUserId, lineId: nextLineId() });
const resumedBy = (requestedByUserId = "ada"): PlaybackEvent =>
  ({ kind: "resumed", requestedByUserId, lineId: nextLineId() });
const paused = () => pausedBy();
const resumed = () => resumedBy();
const cleared: PlaybackEvent = { kind: "cleared" };

/**
 * The three targeted events name an entry, so a test that means "the one that
 * is playing" has to look at the state to say so. Written as functions of the
 * state for that reason rather than as constants — which is also what makes a
 * *stale* target easy to write: capture the id first, then let the Queue move.
 */
const endsHead = (state: PlaybackState): PlaybackEvent =>
  ({ kind: "ended", entryId: state.entries[0]?.entryId ?? "nothing-is-playing" });
const skips = (entryId: string, requestedByUserId = "ada"): PlaybackEvent =>
  ({ kind: "skipped", entryId, requestedByUserId, lineId: nextLineId() });
const skipsHead = (state: PlaybackState): PlaybackEvent =>
  skips(state.entries[0]?.entryId ?? "nothing-is-playing");
const skipsHeadBy = (requestedByUserId: string) => (state: PlaybackState): PlaybackEvent =>
  skips(state.entries[0]?.entryId ?? "nothing-is-playing", requestedByUserId);
const removes = (entryId: string, requestedByUserId = "ada"): PlaybackEvent =>
  ({ kind: "removed", entryId, requestedByUserId, lineId: nextLineId() });

/** The entry at a place in the Queue, so a test can name what it means to skip. */
const idAt = (state: PlaybackState, index: number) => state.entries[index]!.entryId;

/** An event, or one that has to look at the state to know what it is aimed at. */
type Step = PlaybackEvent | ((state: PlaybackState) => PlaybackEvent);

/** Applies a run of events, returning the state and the last set of effects. */
function run(events: Step[], from: PlaybackState = emptyPlayback()) {
  let state = from;
  let effects: PlaybackEffect[] = [];
  for (const event of events) {
    const step = advancePlayback(state, typeof event === "function" ? event(state) : event);
    state = step.state;
    effects = step.effects;
  }
  return { state, effects };
}

const ids = (state: PlaybackState) => state.entries.map((item) => item.track.id);

describe("adding a Track", () => {
  it("plays the first one immediately", () => {
    const { state, effects } = run([added("aB3dE5gH7jK")]);

    assert.deepEqual(ids(state), ["aB3dE5gH7jK"]);
    assert.equal(state.playing, true);
    assert.deepEqual(effects, [{ kind: "load", entry: state.entries[0] }, { kind: "play" }, { kind: "publish" }]);
  });

  it("appends to the Queue instead of interrupting what is playing", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS")]);

    assert.deepEqual(ids(state), ["aB3dE5gH7jK", "zY9xW7vU5tS"]);
    assert.equal(state.playing, true);
    // The room hears about it; the player is not touched. Anything that loaded
    // the second Track here would cut the first one off mid-bar.
    assert.deepEqual(effects, [{ kind: "publish" }]);
  });

  it("appends behind a paused Track rather than starting it", () => {
    // Pausing is not the same as having nothing to play. A Track added while
    // the Queue is paused waits its turn like any other.
    const { state, effects } = run([added("aB3dE5gH7jK"), paused, added("zY9xW7vU5tS")]);

    assert.deepEqual(ids(state), ["aB3dE5gH7jK", "zY9xW7vU5tS"]);
    assert.equal(state.playing, false);
    assert.deepEqual(effects, [{ kind: "publish" }]);
  });

  it("keeps the two members who queued the same Track apart", () => {
    const { state } = run([added("aB3dE5gH7jK", "ada"), added("aB3dE5gH7jK", "bob")]);

    assert.deepEqual(state.entries.map((item) => item.requestedByUserId), ["ada", "bob"]);
    assert.equal(
      new Set(state.entries.map((item) => item.entryId)).size,
      2,
      "each addition is its own entry, so removing one does not take the other"
    );
  });

  it("refuses a Track that would take the Queue past its bound", () => {
    let state = emptyPlayback();
    for (let index = 0; index < musicQueueMaxEntries; index += 1) {
      state = advancePlayback(state, added(`track-${index}`)).state;
    }

    const step = advancePlayback(state, added("one-too-many"));

    assert.equal(step.refusal, "queue_full");
    assert.equal(step.state, state, "a refused addition changes nothing at all");
    assert.deepEqual(step.effects, []);
  });
});

describe("one Track ending", () => {
  it("advances to the next one", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS"), endsHead]);

    assert.deepEqual(ids(state), ["zY9xW7vU5tS"]);
    assert.equal(state.playing, true);
    assert.deepEqual(effects, [{ kind: "load", entry: state.entries[0] }, { kind: "play" }, { kind: "publish" }]);
  });

  it("plays a whole Queue through in the order it was built", () => {
    let state = emptyPlayback();
    const played: string[] = [];
    for (const id of ["one", "two", "three"]) state = advancePlayback(state, added(id)).state;

    for (let index = 0; index < 3; index += 1) {
      played.push(state.entries[0].track.id);
      state = advancePlayback(state, endsHead(state)).state;
    }

    assert.deepEqual(played, ["one", "two", "three"]);
    assert.deepEqual(ids(state), []);
  });

  it("empties the Queue and stops when there is nothing behind it", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), endsHead]);

    assert.deepEqual(ids(state), []);
    assert.equal(state.playing, false);
    // `unload` and not `load`: the fetch behind a Track nobody is going to hear
    // is bandwidth spent on nothing.
    assert.deepEqual(effects, [{ kind: "unload" }, { kind: "publish" }]);
  });

  it("does nothing at all when there was nothing playing", () => {
    const step = advancePlayback(emptyPlayback(), endsHead(emptyPlayback()));

    assert.deepEqual(step.state, emptyPlayback());
    assert.deepEqual(step.effects, []);
  });
});

describe("pausing and resuming", () => {
  it("stops without losing the Queue", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS"), paused]);

    assert.deepEqual(ids(state), ["aB3dE5gH7jK", "zY9xW7vU5tS"]);
    assert.equal(state.playing, false);
    assert.deepEqual(effects, [{ kind: "stop" }, { kind: "publish" }]);
  });

  it("resumes the Track that is already loaded rather than fetching it again", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), paused, resumed]);

    assert.equal(state.playing, true);
    assert.deepEqual(effects, [{ kind: "play" }, { kind: "publish" }], "no `load`, so no second fetch");
  });

  it("treats a repeated pause or resume as the request it already answered", () => {
    const twice = run([added("aB3dE5gH7jK"), paused, paused]);
    assert.deepEqual(twice.effects, [], "nothing changed, so the room is not told again");

    const again = run([added("aB3dE5gH7jK"), resumed]);
    assert.deepEqual(again.effects, []);
  });

  it("has nothing to resume when the Queue is empty", () => {
    const step = advancePlayback(emptyPlayback(), resumedBy());

    assert.equal(step.state.playing, false);
    assert.deepEqual(step.effects, []);
  });
});

describe("skipping", () => {
  it("advances to the next Track", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS"), skipsHead]);

    assert.deepEqual(ids(state), ["zY9xW7vU5tS"]);
    assert.equal(state.playing, true);
    assert.deepEqual(effects, [{ kind: "load", entry: state.entries[0] }, { kind: "play" }, { kind: "publish" }]);
  });

  it("advances exactly one Track when two members skip the same one at once", () => {
    // The whole answer to the race, and it needs no lock and no sequence
    // number: both requests name the Track they meant, and the second one
    // arrives to find that Track already gone.
    const queued = run([added("one"), added("two"), added("three")]).state;
    const playing = idAt(queued, 0);

    const first = advancePlayback(queued, skips(playing));
    const second = advancePlayback(first.state, skips(playing));

    assert.deepEqual(ids(first.state), ["two", "three"]);
    assert.deepEqual(ids(second.state), ["two", "three"], "the coincidence did not cost a second Track");
    assert.deepEqual(second.effects, [], "and the room is not told about a change that did not happen");
  });

  it("succeeds silently rather than refusing a skip that arrived late", () => {
    // Not a refusal: the member asked for the Track to stop playing and it is
    // not playing. Answering with an error would put a sentence in front of
    // somebody who got exactly what they wanted.
    const queued = run([added("one"), added("two")]).state;

    const step = advancePlayback(queued, skips("an-entry-from-a-previous-Set"));

    assert.equal(step.refusal, undefined);
    assert.equal(step.state, queued, "the state it was given, not a copy of it");
    assert.deepEqual(step.effects, []);
  });

  it("only ever moves past the head, never a Track waiting its turn", () => {
    // A skip is "move on from what is playing". A panel one message out of date
    // must not be able to turn that into deleting somebody else's Track.
    const queued = run([added("one"), added("two"), added("three")]).state;

    const step = advancePlayback(queued, skips(idAt(queued, 1)));

    assert.deepEqual(ids(step.state), ["one", "two", "three"]);
    assert.deepEqual(step.effects, []);
  });

  it("empties the Queue and stops the player when there is nothing behind it", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), skipsHead]);

    assert.deepEqual(ids(state), []);
    assert.equal(state.playing, false);
    // `stop` and not merely `unload`: unlike a Track that ended of its own
    // accord, this one was still sounding a moment ago.
    assert.deepEqual(effects, [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]);
  });

  it("leaves a paused Queue paused", () => {
    // Skipping says which Track, not whether to play. Somebody who paused the
    // music to talk should not have the next one start under them.
    const { state, effects } = run([added("one"), added("two"), paused, skipsHead]);

    assert.deepEqual(ids(state), ["two"]);
    assert.equal(state.playing, false);
    assert.deepEqual(
      effects,
      [{ kind: "load", entry: state.entries[0] }, { kind: "publish" }],
      "the next Track is loaded so a resume plays it, and no `play` starts it early"
    );
  });

  it("has nothing to skip in an empty Queue", () => {
    const empty = emptyPlayback();

    const step = advancePlayback(empty, skips("anything"));

    assert.equal(step.state, empty);
    assert.deepEqual(step.effects, []);
  });
});

describe("removing a Track", () => {
  it("takes out the one it names and leaves the rest in order", () => {
    const queued = run([added("one"), added("two"), added("three")]).state;

    const step = advancePlayback(queued, removes(idAt(queued, 1)));

    assert.deepEqual(ids(step.state), ["one", "three"]);
    assert.equal(step.state.playing, true, "what is playing is not disturbed by a change behind it");
    assert.deepEqual(step.effects, [{ kind: "publish" }], "nothing is loaded and nothing is stopped");
  });

  it("advances to the next Track when the one removed was playing", () => {
    const queued = run([added("one"), added("two")]).state;

    const step = advancePlayback(queued, removes(idAt(queued, 0)));

    assert.deepEqual(ids(step.state), ["two"]);
    assert.equal(step.state.playing, true);
    assert.deepEqual(step.effects, [
      { kind: "load", entry: step.state.entries[0] },
      { kind: "play" },
      { kind: "publish" }
    ]);
  });

  it("removes the entry and not the Track, so the other copy stays", () => {
    // Two members queued the same link. They are two entries, and taking one
    // out must leave the other's evening alone.
    const queued = run([added("one"), added("shared", "ada"), added("shared", "bob")]).state;

    const step = advancePlayback(queued, removes(idAt(queued, 1)));

    assert.deepEqual(
      step.state.entries.map((item) => item.requestedByUserId),
      ["ada", "bob"],
      "the head keeps its Requester and bob's copy of the shared Track survives"
    );
    assert.deepEqual(ids(step.state), ["one", "shared"]);
  });

  it("removes one Track when the same entry is removed twice", () => {
    const queued = run([added("one"), added("two"), added("three")]).state;
    const target = idAt(queued, 1);

    const first = advancePlayback(queued, removes(target));
    const second = advancePlayback(first.state, removes(target));

    assert.deepEqual(ids(first.state), ["one", "three"]);
    assert.deepEqual(ids(second.state), ["one", "three"]);
    assert.deepEqual(second.effects, []);
  });

  it("changes nothing when the Queue has already moved past the entry", () => {
    // The Queue changed in between — the Track ended, or somebody skipped it.
    // Removing by position would take out whatever moved up into its place.
    const queued = run([added("one"), added("two"), added("three")]).state;
    const target = idAt(queued, 0);
    const advanced = advancePlayback(queued, skips(target)).state;

    const step = advancePlayback(advanced, removes(target));

    assert.equal(step.state, advanced);
    assert.deepEqual(step.effects, []);
    assert.deepEqual(ids(step.state), ["two", "three"]);
  });

  it("empties the Queue and stops the player when it removes the last Track", () => {
    const queued = run([added("only")]).state;

    const step = advancePlayback(queued, removes(idAt(queued, 0)));

    assert.deepEqual(ids(step.state), []);
    assert.equal(step.state.playing, false);
    assert.deepEqual(step.effects, [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]);
  });

  it("does not start the music by removing the paused Track in front of it", () => {
    const queued = run([added("one"), added("two"), paused]).state;

    const step = advancePlayback(queued, removes(idAt(queued, 0)));

    assert.deepEqual(ids(step.state), ["two"]);
    assert.equal(step.state.playing, false);
    assert.deepEqual(step.effects, [{ kind: "load", entry: step.state.entries[0] }, { kind: "publish" }]);
  });
});

describe("a Track ending after the Queue moved on", () => {
  it("ignores the end of a Track that is no longer the one playing", () => {
    // The player reported the end of the Track it was given; by the time that
    // reached the Queue, a skip had already moved past it. Acting on it anyway
    // would drop the Track that had just started, which nobody asked for.
    const queued = run([added("one"), added("two")]).state;
    const wasPlaying = idAt(queued, 0);
    const advanced = advancePlayback(queued, skips(wasPlaying)).state;

    const step = advancePlayback(advanced, { kind: "ended", entryId: wasPlaying });

    assert.deepEqual(ids(step.state), ["two"], "the Track the skip started is still there");
    assert.deepEqual(step.effects, []);
  });
});

describe("the Set ending", () => {
  it("discards the Queue and says so before anything is torn down", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS"), cleared]);

    assert.deepEqual(ids(state), []);
    assert.equal(state.playing, false);
    assert.deepEqual(effects, [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]);
  });

  it("says nothing when there was no Queue to discard", () => {
    assert.deepEqual(advancePlayback(emptyPlayback(), cleared).effects, []);
  });
});

/**
 * The Set log. Every line here is written by the same transition that changed
 * the Queue, which is the property the whole thing rests on: a request that
 * changed nothing writes no line, so no member is ever named for something
 * that did not happen.
 */
describe("the Set log", () => {
  const actions = (state: PlaybackState) => state.log.map((line) => line.action);
  const said = (state: PlaybackState) =>
    state.log.map((line) => `${line.requestedByUserId} ${line.action} ${line.trackTitle ?? "-"}`);

  it("names the member who added a Track and the Track they added", () => {
    const { state } = run([added("aB3dE5gH7jK", "ada-id")]);

    assert.deepEqual(said(state), ["ada-id added Track aB3dE5gH7jK"]);
  });

  it("names the member who skipped, and the Track they skipped", () => {
    // The Track by name and not by `entryId`: the point of the line is that the
    // entry has gone, so there is nothing left in the Queue to look it up in.
    const queued = run([added("one"), added("two")]).state;

    const { state } = run([skipsHeadBy("bob-id")], queued);

    assert.equal(state.log[0].trackTitle, "Track one", "the Track that stopped, not the one that started");
    assert.equal(state.log[0].requestedByUserId, "bob-id");
    assert.deepEqual(actions(state), ["skipped", "added", "added"]);
  });

  it("writes nothing for a skip that named a Track the Queue had moved past", () => {
    // The half of ADR-0006 the log has to honour. That skip succeeds, changes
    // nothing and publishes nothing — so a line for it would tell four people
    // that a member skipped a Track nobody skipped, in a panel that is showing
    // them the Track still playing.
    const queued = run([added("one"), added("two")]).state;
    const wasPlaying = idAt(queued, 0);
    const advanced = run([skipsHead], queued).state;

    const step = advancePlayback(advanced, skips(wasPlaying, "late-id"));

    assert.equal(step.state, advanced, "the state it was given, log and all");
    assert.deepEqual(step.effects, [], "no publish, and so no line either");
  });

  it("says a removal was a removal, even when it took the Track that was playing", () => {
    // Removing the head advances the Queue exactly as a skip does, and the two
    // are one rule in the code. They are still two things a member did, and the
    // log is the whole reason ADR-0006 kept them apart as two verbs.
    const queued = run([added("one"), added("two")]).state;

    const { state } = run([removes(idAt(queued, 0), "ece-id")], queued);

    assert.deepEqual(actions(state), ["removed", "added", "added"]);
    assert.deepEqual(said(state)[0], "ece-id removed Track one");
  });

  it("names the Track a removal took out of the middle of the Queue", () => {
    const queued = run([added("one"), added("two"), added("three")]).state;

    const { state } = run([removes(idAt(queued, 1), "ece-id")], queued);

    assert.deepEqual(said(state)[0], "ece-id removed Track two");
  });

  it("writes nothing for a removal naming an entry the Queue no longer holds", () => {
    const queued = run([added("one")]).state;

    const step = advancePlayback(queued, removes("an-entry-from-a-previous-Set"));

    assert.equal(step.state, queued);
    assert.deepEqual(step.effects, []);
  });

  it("names the member who paused and the one who resumed, and no Track", () => {
    // A pause is about the Queue rather than about any one Track, and the Track
    // it stopped is still sitting at the head of the list saying "Paused".
    const { state } = run([added("one"), pausedBy("ada-id"), resumedBy("bob-id")]);

    assert.deepEqual(said(state), ["bob-id resumed -", "ada-id paused -", "ada added Track one"]);
  });

  it("writes nothing for a pause that arrived at an already-paused Queue", () => {
    // The same rule as a stale skip, reached from the other side: nothing
    // changed and the room was told nothing, so naming a member for it would
    // describe a pause that nobody experienced.
    const stopped = run([added("one"), paused]).state;

    const step = advancePlayback(stopped, pausedBy("late-id"));

    assert.equal(step.state, stopped);
    assert.deepEqual(step.effects, []);
  });

  it("writes nothing for a resume with nothing to resume", () => {
    const playing = run([added("one")]).state;
    const empty = emptyPlayback();

    assert.equal(advancePlayback(playing, resumedBy("late-id")).state, playing, "already playing");
    assert.deepEqual(advancePlayback(empty, resumedBy("late-id")).state.log, [], "and an empty Queue");
  });

  it("writes nothing for a Track that ended by itself", () => {
    // The log names who did something. Nobody ended it, and a line naming the
    // member whose Track it was would say they skipped a Track they queued.
    const queued = run([added("one"), added("two")]).state;

    const { state } = run([endsHead], queued);

    assert.deepEqual(actions(state), ["added", "added"], "the two additions, and nothing for the ending");
  });

  it("keeps the most recent lines and lets the oldest fall off the back", () => {
    // The opposite of what a full Queue does, and on purpose: a Queue is a
    // promise about what will play, so the member who would lose their Track is
    // refused; a log is a record of what already happened, and what is worth
    // keeping is the recent part.
    let state = run([added("one")]).state;
    for (let index = 0; index < musicSetLogMaxLines + 5; index += 1) {
      state = run([index % 2 === 0 ? paused : resumed], state).state;
    }

    assert.equal(state.log.length, musicSetLogMaxLines);
    assert.equal(state.log.at(-1)?.action, "resumed", "the addition at the start has gone");
    assert.equal(
      new Set(state.log.map((line) => line.lineId)).size,
      musicSetLogMaxLines,
      "every line is its own, so two identical pauses are two rows"
    );
  });

  it("keeps two members who did the same thing apart", () => {
    const queued = run([added("one"), pausedBy("ada-id"), resumedBy("ada-id")]).state;

    const { state } = run([pausedBy("bob-id")], queued);

    assert.deepEqual(state.log.map((line) => line.requestedByUserId), ["bob-id", "ada-id", "ada-id", "ada"]);
  });

  it("goes with the Set, and says so to the room before the Set is torn down", () => {
    // This is the whole of "the Set log is cleared when the Music bot leaves":
    // the log is part of the state the Set holds, so discarding the state
    // discards it, and the empty publish that goes out first is what takes it
    // off everybody's panel.
    const played = run([added("one"), pausedBy("ada-id"), cleared]);

    assert.deepEqual(played.state.log, []);
    assert.deepEqual(played.effects, [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]);
  });

  it("tells the room even when the log is all that is left to discard", () => {
    // A Set whose Tracks have all played out has an empty Queue and a log full
    // of what people did to it. Saying nothing here would leave that log on
    // five panels for a Set that is over.
    const spent = run([added("one"), endsHead]).state;
    assert.deepEqual(ids(spent), [], "nothing queued, but something to forget");

    const step = advancePlayback(spent, cleared);

    assert.deepEqual(step.state.log, []);
    assert.deepEqual(step.effects, [{ kind: "stop" }, { kind: "unload" }, { kind: "publish" }]);
  });

  it("still says nothing when there is nothing at all to discard", () => {
    assert.deepEqual(advancePlayback(emptyPlayback(), cleared).effects, []);
  });

  it("puts nothing on a line but the four fields the wire agreed on", () => {
    // The transitions build a line by spreading the event they were handed,
    // which carries `kind` and an `entryId` as well. A field riding along here
    // is not cosmetic: the server validates this payload with `strict()`, so it
    // would refuse the *whole* publish — and the room would stop being told
    // about the Queue at all, for a reason nothing in the panel could show.
    const queued = run([added("one"), added("two"), added("three")]).state;
    const { state } = run(
      [skipsHeadBy("bob-id"), pausedBy("bob-id"), resumedBy("bob-id"), (later) => removes(idAt(later, 1), "bob-id")],
      queued
    );

    assert.equal(state.log.length, 7, "every verb is represented");
    for (const line of state.log) {
      assert.deepEqual(
        Object.keys(line).sort(),
        ["action", "lineId", "requestedByUserId", "trackTitle"],
        line.action
      );
    }
  });
});

describe("what the room is shown", () => {
  it("carries the Requester as an id and never a nickname", () => {
    const { state } = run([added("aB3dE5gH7jK", "ada-id")]);

    const published = publishedQueue(state);

    assert.equal(published.playing, true);
    assert.equal(published.entries.length, 1);
    assert.deepEqual(published.entries[0], {
      entryId: state.entries[0].entryId,
      requestedByUserId: "ada-id",
      track: { id: "aB3dE5gH7jK", title: "Track aB3dE5gH7jK", durationSeconds: 273 }
    });
  });

  it("leaves the bot's own knowledge of the Track behind", () => {
    const { state } = run([added("aB3dE5gH7jK")]);

    const [published] = publishedQueue(state).entries;

    assert.equal("url" in published.track, false, "how to fetch it again is nobody else's business");
  });

  it("publishes an empty Queue as an empty Queue, not as nothing", () => {
    assert.deepEqual(publishedQueue(emptyPlayback()), { entries: [], playing: false, log: [] });
  });

  it("carries the Set log to the room on the same message as the Queue", () => {
    // One payload, so a line and the change it describes can never arrive out
    // of order or one without the other. ADR-0008.
    const { state } = run([added("aB3dE5gH7jK", "ada-id"), pausedBy("bob-id")]);

    const published = publishedQueue(state);

    assert.deepEqual(published.log.map((line) => [line.requestedByUserId, line.action, line.trackTitle]), [
      ["bob-id", "paused", null],
      ["ada-id", "added", "Track aB3dE5gH7jK"]
    ]);
    assert.equal(published.entries.length, 1, "and the Queue the lines are about, in the same breath");
  });
});
