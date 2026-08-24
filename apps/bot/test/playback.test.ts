import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { musicQueueMaxEntries } from "@voxly/shared";
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

const added = (id: string, requestedByUserId?: string): PlaybackEvent =>
  ({ kind: "added", entry: entry(id, requestedByUserId) });
const ended: PlaybackEvent = { kind: "ended" };
const paused: PlaybackEvent = { kind: "paused" };
const resumed: PlaybackEvent = { kind: "resumed" };
const cleared: PlaybackEvent = { kind: "cleared" };

/** Applies a run of events, returning the state and the last set of effects. */
function run(events: PlaybackEvent[], from: PlaybackState = emptyPlayback()) {
  let state = from;
  let effects: PlaybackEffect[] = [];
  for (const event of events) {
    const step = advancePlayback(state, event);
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
    assert.deepEqual(effects, [
      { kind: "load", track: trackFor("aB3dE5gH7jK") },
      { kind: "play" },
      { kind: "publish" }
    ]);
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
    const { state, effects } = run([added("aB3dE5gH7jK"), added("zY9xW7vU5tS"), ended]);

    assert.deepEqual(ids(state), ["zY9xW7vU5tS"]);
    assert.equal(state.playing, true);
    assert.deepEqual(effects, [
      { kind: "load", track: trackFor("zY9xW7vU5tS") },
      { kind: "play" },
      { kind: "publish" }
    ]);
  });

  it("plays a whole Queue through in the order it was built", () => {
    let state = emptyPlayback();
    const played: string[] = [];
    for (const id of ["one", "two", "three"]) state = advancePlayback(state, added(id)).state;

    for (let index = 0; index < 3; index += 1) {
      played.push(state.entries[0].track.id);
      state = advancePlayback(state, ended).state;
    }

    assert.deepEqual(played, ["one", "two", "three"]);
    assert.deepEqual(ids(state), []);
  });

  it("empties the Queue and stops when there is nothing behind it", () => {
    const { state, effects } = run([added("aB3dE5gH7jK"), ended]);

    assert.deepEqual(ids(state), []);
    assert.equal(state.playing, false);
    // `unload` and not `load`: the fetch behind a Track nobody is going to hear
    // is bandwidth spent on nothing.
    assert.deepEqual(effects, [{ kind: "unload" }, { kind: "publish" }]);
  });

  it("does nothing at all when there was nothing playing", () => {
    const step = advancePlayback(emptyPlayback(), ended);

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
    const step = advancePlayback(emptyPlayback(), resumed);

    assert.equal(step.state.playing, false);
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
    assert.deepEqual(publishedQueue(emptyPlayback()), { entries: [], playing: false });
  });
});
