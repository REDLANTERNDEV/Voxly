import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { musicQueueMaxEntries, type MusicCommand, type MusicQueueState, type VoiceForceLeaveReason } from "@voxly/shared";
import type { BotEnvironment } from "../src/config.js";
import { createMusicResponder } from "../src/music.js";
import { TrackBuffer } from "../src/audio.js";
import type { MusicSet, MusicSetOptions, SetSocket } from "../src/set.js";
import type { TrackAudio } from "../src/stream.js";
import type { SearchResult, TrackResult } from "../src/track.js";

/**
 * The responder is tested against a stand-in Set, a stand-in extractor and a
 * stand-in fetch. What a Set does when it is begun is proven in `set.test.ts`
 * and `mesh.test.ts`; what a link means is proven in `track.test.ts`; what the
 * Queue *is* — appending, advancing, pausing — is proven in `playback.test.ts`.
 * What matters here is the order things happen in, which Set exists when, and
 * that the room is told.
 */

const environment: BotEnvironment = {
  serverUrl: "http://127.0.0.1:3000",
  token: "a-bot-token-that-is-long-enough",
  extractorPath: "yt-dlp",
  encoderPath: "ffmpeg",
  extractorClient: ""
};

const link = "https://www.youtube.com/watch?v=aB3dE5gH7jK";
const otherLink = "https://youtu.be/zY9xW7vU5tS";

/**
 * One verb carries both a pasted link and a typed name, because which of the
 * two a string is is the bot's own knowledge. These two helpers are the same
 * command with different contents, and that is the point.
 */
const add = (input = link): MusicCommand => ({ kind: "add", input });
const search = (name: string): MusicCommand => ({ kind: "add", input: name });
const play: MusicCommand = { kind: "play" };
const stop: MusicCommand = { kind: "stop" };
const leave: MusicCommand = { kind: "leave" };
/**
 * Both verbs name an entry, and the harness mints them in order — `entry-1` is
 * the first Track added, `entry-2` the second. Naming them literally is what
 * lets a test hold a *stale* one, which is the case that matters.
 */
const skip = (entryId: string): MusicCommand => ({ kind: "skip", entryId });
const remove = (entryId: string): MusicCommand => ({ kind: "remove", entryId });

/** One Result a search offered, as the wire carries it. */
function resultFor(id: string) {
  return {
    track: { id, title: `Track ${id}`, durationSeconds: 273 },
    channel: "A Channel",
    url: `https://www.youtube.com/watch?v=${id}`
  };
}

function trackFor(id: string) {
  return {
    ok: true as const,
    track: { id, title: `Track ${id}`, durationSeconds: 273, url: `https://www.youtube.com/watch?v=${id}` }
  };
}

interface FakeSet extends MusicSet {
  readonly events: string[];
}

function harness(options: {
  failToBegin?: string;
  resolveAs?: TrackResult;
  searchAs?: SearchResult;
  /** Parks the extractor mid-answer, so a test can hold the chain open. */
  holdResolve?: boolean;
} = {}) {
  const created: FakeSet[] = [];
  const endTrack = new Map<string, () => void>();
  const iceRequests: number[] = [];
  const log: string[] = [];
  const resolved: string[] = [];
  const searched: string[] = [];
  const fetched: string[] = [];
  const cancelled: string[] = [];
  const forceLeaveHandlers = new Set<(payload: { roomId: string; reason: VoiceForceLeaveReason }) => void>();
  const published: Array<{ roomId: string; state: MusicQueueState }> = [];
  const rosterHooks = new Map<string, (memberUserIds: string[]) => void>();
  // Only the eviction hook is reached from here; everything else on the socket
  // belongs to a Set, and the Sets in this file are stand-ins.
  const socket = {
    onForceLeave(handler) {
      forceLeaveHandlers.add(handler);
    },
    offForceLeave(handler) {
      forceLeaveHandlers.delete(handler);
    }
  } as Pick<SetSocket, "onForceLeave" | "offForceLeave"> as SetSocket;

  const createSet = (setOptions: MusicSetOptions): MusicSet => {
    const events: string[] = [];
    let playing = false;
    if (setOptions.onListenersChanged) rosterHooks.set(setOptions.roomId, setOptions.onListenersChanged);
    endTrack.set(setOptions.roomId, () => setOptions.onTrackEnded?.());
    const set: FakeSet = {
      events,
      roomId: setOptions.roomId,
      get playing() {
        return playing;
      },
      listenerUserIds: [],
      async begin() {
        events.push("begin");
        if (options.failToBegin === setOptions.roomId) throw new Error("voice:join refused: forbidden");
      },
      loadTrack() {
        events.push("load");
      },
      play() {
        playing = true;
        events.push("play");
      },
      stop() {
        playing = false;
        events.push("stop");
      },
      async end() {
        events.push("end");
      }
    };
    created.push(set);
    return set;
  };

  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let minted = 0;
  const responder = createMusicResponder({
    socket,
    selfUserId: "aaaa-bot",
    environment,
    publish: (payload) => published.push({ roomId: payload.roomId, state: payload.state }),
    mintEntryId: () => `entry-${(minted += 1)}`,
    loadIceServers: async () => {
      iceRequests.push(Date.now());
      return [];
    },
    createSet: createSet as never,
    resolve: async (_environment, url) => {
      resolved.push(url);
      if (options.holdResolve) await held;
      return options.resolveAs ?? trackFor(url.slice(-11));
    },
    search: async (_environment, name) => {
      searched.push(name);
      return options.searchAs ?? { ok: true, results: [resultFor("aB3dE5gH7jK"), resultFor("qW8eR2tY6uI")] };
    },
    fetch: (_environment, track): TrackAudio => {
      fetched.push(track.id);
      return { buffer: new TrackBuffer(), cancel: () => cancelled.push(track.id) };
    },
    log: (message) => log.push(message)
  });

  return {
    responder,
    created,
    iceRequests,
    log,
    resolved,
    searched,
    fetched,
    cancelled,
    published,
    /** The Queue the room was last told about. */
    lastPublished: () => published.at(-1)?.state,
    /** The Track that is playing reached its end, as the player reports it. */
    endTrack: (roomId: string) => endTrack.get(roomId)?.(),
    /** Somebody joined or left the voice room the Set is in. */
    rosterChanged(roomId: string, memberUserIds: string[]) {
      rosterHooks.get(roomId)?.(memberUserIds);
    },
    forceLeave(roomId: string, reason: VoiceForceLeaveReason = "owner_disconnect") {
      for (const handler of forceLeaveHandlers) handler({ roomId, reason });
    },
    forceLeaveSubscribers: () => forceLeaveHandlers.size,
    /** Lets a parked extractor answer, and with it the command holding the chain. */
    releaseResolve: () => release()
  };
}

/** Every request carries the member who made it; most tests do not care which. */
const ada = "ada-user-id";
const titles = (state: MusicQueueState | undefined) => state?.entries.map((item) => item.track.title) ?? [];

describe("a pasted link", () => {
  it("summons the bot, loads the Track and starts playing", async () => {
    const { responder, created, fetched } = harness();

    const answer = await responder.handle(add(), "lobby", ada);

    assert.deepEqual(answer, {
      ok: true,
      kind: "track",
      track: { id: "aB3dE5gH7jK", title: "Track aB3dE5gH7jK", durationSeconds: 273 }
    });
    assert.deepEqual(created[0]?.events, ["begin", "load", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });

  it("asks the extractor about the canonical link, not the one that was pasted", async () => {
    // Two people pasting the same video from different places — a share link
    // with a timestamp, a mobile link with a tracking parameter — must ask for
    // exactly the same thing.
    const { responder, resolved } = harness();

    await responder.handle(add("https://youtu.be/aB3dE5gH7jK?si=xyz&t=90"), "lobby", ada);

    assert.deepEqual(resolved, [link]);
  });

  it("refuses a link that is not one video, without spawning anything", async () => {
    const { responder, resolved, created } = harness();

    const answer = await responder.handle(add("https://open.spotify.com/track/4cOdK2wGLETKBW3"), "lobby", ada);

    assert.deepEqual(answer, { ok: false, error: "unsupported_link" });
    assert.deepEqual(resolved, [], "the extractor is never asked about a link it could not use");
    assert.deepEqual(created, [], "and the bot does not appear in the channel to say so");
  });

  it("reports what the extractor said without joining the channel", async () => {
    // A member who pasted a dead link should be told. Summoning first would put
    // a silent bot in the channel that then has to be sent away again.
    for (const error of ["track_unavailable", "live_stream", "extractor_failed"] as const) {
      const { responder, created } = harness({ resolveAs: { ok: false, error } });

      assert.deepEqual(await responder.handle(add(), "lobby", ada), { ok: false, error });
      assert.deepEqual(created, [], error);
    }
  });

  it("appends to the Queue when another link arrives, rather than interrupting", async () => {
    const { responder, created, fetched, cancelled, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);

    const answer = await responder.handle(add(otherLink), "lobby", ada);

    assert.equal(created.length, 1, "a second Track is not a second Set");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play"], "the player is not touched by the second one");
    assert.deepEqual(fetched, ["aB3dE5gH7jK"], "and nothing is fetched until it is its turn");
    assert.deepEqual(cancelled, [], "the Track that is playing keeps its fetch");
    assert.deepEqual(titles(lastPublished()), ["Track aB3dE5gH7jK", "Track zY9xW7vU5tS"]);
    assert.deepEqual(answer, {
      ok: true,
      kind: "track",
      track: { id: "zY9xW7vU5tS", title: "Track zY9xW7vU5tS", durationSeconds: 273 }
    }, "the answer names the Track the asker added, not the one playing");
  });

  it("plays the Queue in order, advancing when a Track ends", async () => {
    const { responder, created, fetched, cancelled, endTrack, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    endTrack("lobby");
    // The end is handled through the same chain as a command, so it has landed
    // by the time the next request is answered.
    await responder.handle(play, "lobby", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK", "zY9xW7vU5tS"], "the next Track is fetched when its turn comes");
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"], "and the finished one's fetch is abandoned");
    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"]);
  });

  it("empties the Queue when the last Track ends", async () => {
    const { responder, cancelled, endTrack, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);

    endTrack("lobby");
    await responder.handle(play, "lobby", ada);

    assert.deepEqual(titles(lastPublished()), []);
    assert.equal(lastPublished()?.playing, false);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), "lobby", "an empty Queue is not a Set that ended");
  });

  it("does not refuse a room its first Track because another room's Queue is full", async () => {
    // The bound belongs to the Queue being added to. Being summoned elsewhere
    // ends the Set that was running and takes its Queue with it, so a paste
    // into a new room must not be refused on the strength of a Queue that is
    // about to stop existing.
    const { responder, lastPublished } = harness();
    for (let index = 0; index < musicQueueMaxEntries; index += 1) {
      await responder.handle(add(`https://youtu.be/${String(index).padStart(11, "a")}`), "lobby", ada);
    }
    assert.deepEqual(
      await responder.handle(add(otherLink), "lobby", ada),
      { ok: false, error: "queue_full" },
      "the room whose Queue is actually full is still refused"
    );

    const answer = await responder.handle(add(otherLink), "studio", ada);

    assert.equal(answer.ok, true);
    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"]);
    assert.equal(responder.currentRoomId(), "studio");
  });

  it("records who asked for each Track, as an id rather than a name", async () => {
    const { responder, lastPublished } = harness();

    await responder.handle(add(), "lobby", "ada-user-id");
    await responder.handle(add(otherLink), "lobby", "bob-user-id");

    assert.deepEqual(
      lastPublished()?.entries.map((entry) => entry.requestedByUserId),
      ["ada-user-id", "bob-user-id"]
    );
  });

  it("reads the RTC configuration once per Set, not once per Track", async () => {
    // TURN credentials are short-lived, so they are fetched when a Set starts —
    // but adding another Track is not a new Set.
    const { responder, iceRequests } = harness();

    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    assert.equal(iceRequests.length, 1);
  });

  it("ends the Set it was running when summoned somewhere else", async () => {
    const { responder, created, cancelled } = harness();

    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "studio", ada);

    assert.equal(created.length, 2);
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "end"]);
    assert.deepEqual(created[1]?.events, ["begin", "load", "play"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), "studio");
  });
});

describe("a typed name", () => {
  it("answers with the Tracks it might have meant, and adds none of them", async () => {
    // The member has not chosen yet. Queueing the closest match would be the
    // bot deciding for them, which is the whole reason a list is offered.
    const { responder, searched, resolved, created } = harness();

    const answer = await responder.handle(search("nocturne in e flat"), "lobby", ada);

    assert.deepEqual(answer, {
      ok: true,
      kind: "results",
      results: [resultFor("aB3dE5gH7jK"), resultFor("qW8eR2tY6uI")]
    });
    assert.deepEqual(searched, ["nocturne in e flat"]);
    assert.deepEqual(resolved, [], "nothing is resolved until a member picks one");
    assert.deepEqual(created, [], "and the bot does not appear in the channel to answer a question");
  });

  it("tells only the member who asked, and never the room", async () => {
    // The first thing this panel shows that is not the published Queue. Five
    // members must see one Queue; a list of Results belongs to the one who
    // is still deciding, and publishing it would put four other people's panels
    // in front of a choice that is not theirs. ADR-0007.
    const { responder, published } = harness();

    await responder.handle(search("nocturne"), "lobby", ada);

    assert.deepEqual(published, []);
  });

  it("leaves a Set that is playing somewhere else exactly where it is", async () => {
    // A Summon moves the bot, and a search is not a Summon. Somebody in another
    // channel typing a name must not take the music away from the room that is
    // listening to it.
    const { responder, created, published } = harness();
    await responder.handle(add(), "lobby", ada);
    const before = published.length;

    await responder.handle(search("nocturne"), "annex", ada);

    assert.equal(responder.currentRoomId(), "lobby");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play"], "the Set is untouched");
    assert.equal(published.length, before, "and the room it is playing to is told nothing");
  });

  it("finds nothing without calling it a failure", async () => {
    // Nothing broke and there is nothing to wait out. The panel says so; an
    // error code would send the member off to fix something that is not wrong.
    const { responder } = harness({ searchAs: { ok: true, results: [] } });

    assert.deepEqual(await responder.handle(search("asdfghjkl"), "lobby", ada), {
      ok: true,
      kind: "results",
      results: []
    });
  });

  it("reports a search that failed without ending the Set it was not part of", async () => {
    // The chain's recovery ends the Set, which is right for a Summon that broke
    // halfway and catastrophic for a search that did — the room would lose its
    // music because somebody else mistyped a name.
    const { responder, created } = harness({ searchAs: { ok: false, error: "extractor_failed" } });
    await responder.handle(add(), "lobby", ada);

    const answer = await responder.handle(search("nocturne"), "lobby", ada);

    assert.deepEqual(answer, { ok: false, error: "extractor_failed" });
    assert.equal(responder.currentRoomId(), "lobby", "the Set survives somebody else's failed search");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play"]);
  });

  it("does not wait behind a Summon that is still joining", async () => {
    // The one request that changes nothing is the one request that does not
    // queue. Otherwise a member typing a name is held up by somebody else's
    // join — and a Skip sits behind twelve seconds of somebody else's search.
    const { responder, releaseResolve } = harness({ holdResolve: true });
    const adding = responder.handle(add(), "lobby", ada);

    const answer = await Promise.race([
      responder.handle(search("nocturne"), "lobby", ada),
      new Promise<string>((resolve) => setTimeout(() => resolve("the search waited for the Summon"), 100))
    ]);

    assert.equal(typeof answer === "object" && answer.ok && answer.kind, "results", String(answer));
    releaseResolve();
    await adding;
  });

  it("plays the result a member chose, through the path a paste takes", async () => {
    // The browser hands back the link the bot built rather than one of its own,
    // and it arrives on the same verb a paste does — so nothing about it is
    // trusted for having been round the loop.
    const { responder, resolved, searched } = harness();
    const answer = await responder.handle(search("nocturne"), "lobby", ada);
    const chosen = answer.ok && answer.kind === "results" ? answer.results[1] : undefined;

    const played = await responder.handle(add(chosen?.url), "lobby", ada);

    assert.deepEqual(played, {
      ok: true,
      kind: "track",
      track: { id: "qW8eR2tY6uI", title: "Track qW8eR2tY6uI", durationSeconds: 273 }
    });
    assert.deepEqual(resolved, ["https://www.youtube.com/watch?v=qW8eR2tY6uI"]);
    assert.deepEqual(searched, ["nocturne"], "choosing does not search again");
  });

  it("runs one search at a time, so two members cannot double the extractor", async () => {
    // The one thing this feature has always refused is two extractor runs at
    // once against a source that rate-limits by address — it is the reason
    // nothing is prefetched. Taking searches out of the Set's chain must not
    // quietly take that away with it.
    const running: string[] = [];
    const overlapped: string[] = [];
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const responder = createMusicResponder({
      socket: { onForceLeave() {}, offForceLeave() {} } as unknown as SetSocket,
      selfUserId: "aaaa-bot",
      environment,
      publish: () => undefined,
      loadIceServers: async () => [],
      search: async (_environment, name) => {
        if (running.length > 0) overlapped.push(name);
        running.push(name);
        if (name === "first") await held;
        running.pop();
        return { ok: true, results: [] };
      }
    });

    const first = responder.handle(search("first"), "lobby", ada);
    const second = responder.handle(search("second"), "lobby", ada);
    release();
    await Promise.all([first, second]);

    assert.deepEqual(overlapped, [], "the second search waited for the first");
  });

  it("answers an input with nothing in it as a search that found nothing", async () => {
    // The panel will not send one, but the server bounds the field before
    // trimming, so spaces do arrive. "That link is not a YouTube video" would
    // be the wrong sentence, and asking the source about no characters would be
    // a process spent on nothing.
    const { responder, searched } = harness();

    assert.deepEqual(await responder.handle(search("   "), "lobby", ada), {
      ok: true,
      kind: "results",
      results: []
    });
    assert.deepEqual(searched, []);
  });

  it("refuses a link it cannot play rather than searching for the text of it", async () => {
    const { responder, searched, resolved } = harness();

    const answer = await responder.handle(add("https://open.spotify.com/track/4cOdK2wGLETKBW3"), "lobby", ada);

    assert.deepEqual(answer, { ok: false, error: "unsupported_link" });
    assert.deepEqual(searched, [], "somebody who pasted a link wants to hear that the link is wrong");
    assert.deepEqual(resolved, []);
  });
});

describe("telling the room", () => {
  it("publishes the Queue for the room the Set is in", async () => {
    const { responder, published } = harness();

    await responder.handle(add(), "lobby", ada);

    assert.deepEqual(published.map((entry) => entry.roomId), ["lobby"]);
    assert.deepEqual(published[0]?.state, {
      playing: true,
      entries: [
        {
          entryId: "entry-1",
          requestedByUserId: ada,
          track: { id: "aB3dE5gH7jK", title: "Track aB3dE5gH7jK", durationSeconds: 273 }
        }
      ]
    });
  });

  it("says it again when somebody joins the channel", async () => {
    // The server keeps no copy to hand a newcomer, so whoever just walked in
    // would otherwise be the one person in the room looking at an empty panel.
    const { responder, published, rosterChanged, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    const before = published.length;

    rosterChanged("lobby", ["aaaa-bot", "ada-user-id"]);

    assert.equal(published.length, before + 1);
    assert.deepEqual(titles(lastPublished()), ["Track aB3dE5gH7jK"]);
  });

  it("tells the room the Queue is empty before it leaves the channel", async () => {
    // Order, not decoration: a publish from a member the server has already
    // seen leave is one the server refuses, and the room would be left holding
    // the Queue of a Set that is over.
    const { responder, created, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);

    await responder.handle(leave, "lobby", ada);

    assert.deepEqual(titles(lastPublished()), []);
    assert.deepEqual(created[0]?.events.at(-1), "end", "the Set is torn down after the room was told");
  });
});

describe("stopping and leaving", () => {
  it("stops the Track without leaving the room", async () => {
    const { responder, created } = harness();
    await responder.handle(add(), "lobby", ada);

    assert.deepEqual(await responder.handle(stop, "lobby", ada), { ok: true, kind: "track", track: null });
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop"]);
    assert.equal(responder.currentRoomId(), "lobby", "stopping is not leaving");
  });

  it("resumes the Track that is already loaded", async () => {
    const { responder, created, fetched } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(stop, "lobby", ada);

    await responder.handle(play, "lobby", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK"], "resuming does not fetch the Track again");
  });

  it("leaves the room, forgets the Set and abandons the fetch", async () => {
    const { responder, created, cancelled } = harness();
    await responder.handle(add(), "lobby", ada);

    assert.deepEqual(await responder.handle(leave, "lobby", ada), { ok: true, kind: "track", track: null });
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "end"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), null);
  });

  it("ignores a stop aimed at a room it is not in", async () => {
    // A command that raced a move must not silence the Set the asker was never
    // in. It names the room it means, and this is where that is honoured.
    const { responder, created } = harness();
    await responder.handle(add(), "lobby", ada);

    await responder.handle(stop, "studio", ada);
    await responder.handle(leave, "studio", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });

  it("succeeds at doing nothing when there is no Set to act on", async () => {
    // Not a failure: there is nothing to stop and nothing anyone needs telling.
    // Only `add` summons, so none of these puts a bot in the channel.
    const { responder, created } = harness();

    for (const command of [play, stop, skip("entry-1"), remove("entry-1"), leave]) {
      assert.deepEqual(await responder.handle(command, "lobby", ada), { ok: true, kind: "track", track: null });
    }
    assert.deepEqual(created, []);
  });
});

describe("skipping and removing", () => {
  it("skips the Track that is playing and starts the next one", async () => {
    const { responder, created, fetched, cancelled, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    assert.deepEqual(await responder.handle(skip("entry-1"), "lobby", ada), { ok: true, kind: "track", track: null });

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK", "zY9xW7vU5tS"], "the Track that was skipped to is fetched now");
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"], "and the skipped one's fetch is abandoned");
    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"]);
  });

  it("advances one Track when two members skip the same one at once", async () => {
    const { responder, created, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    await Promise.all([
      responder.handle(skip("entry-1"), "lobby", "ada-user-id"),
      responder.handle(skip("entry-1"), "lobby", "bob-user-id")
    ]);

    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"], "one Track, not two");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
  });

  it("skipping the last Track leaves the bot in the room with nothing queued", async () => {
    const { responder, created, cancelled, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);

    await responder.handle(skip("entry-1"), "lobby", ada);

    assert.deepEqual(titles(lastPublished()), []);
    assert.equal(lastPublished()?.playing, false);
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), "lobby", "an empty Queue is not a Set that ended");
  });

  it("removes a queued Track without disturbing the one playing", async () => {
    const { responder, created, fetched, cancelled, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    assert.deepEqual(await responder.handle(remove("entry-2"), "lobby", ada), { ok: true, kind: "track", track: null });

    assert.deepEqual(created[0]?.events, ["begin", "load", "play"], "the player is not touched");
    assert.deepEqual(fetched, ["aB3dE5gH7jK"]);
    assert.deepEqual(cancelled, []);
    assert.deepEqual(titles(lastPublished()), ["Track aB3dE5gH7jK"]);
  });

  it("removing the Track that is playing advances to the next", async () => {
    const { responder, created, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    await responder.handle(remove("entry-1"), "lobby", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"]);
  });

  it("says nothing to the room about an entry the Queue no longer holds", async () => {
    const { responder, published, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);
    await responder.handle(skip("entry-1"), "lobby", ada);
    const before = published.length;

    assert.deepEqual(await responder.handle(remove("entry-1"), "lobby", ada), { ok: true, kind: "track", track: null });

    assert.equal(published.length, before, "nothing changed, so every client keeps what the bot has");
    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"]);
  });

  it("keeps the Track a skip started when the skipped one's end arrives late", async () => {
    // The player reports the end of the Track it was handed. That report waits
    // its turn in the same chain as the commands, and a skip can get there
    // first — at which point the end belongs to a Track that is already gone,
    // and acting on it would drop the one that had just started.
    const { responder, created, endTrack, lastPublished } = harness();
    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "lobby", ada);

    const skipping = responder.handle(skip("entry-1"), "lobby", ada);
    endTrack("lobby");
    await skipping;
    // Anything answered after both have been through the chain proves they have.
    await responder.handle(play, "lobby", ada);

    assert.deepEqual(titles(lastPublished()), ["Track zY9xW7vU5tS"], "the skip's Track is still playing");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
  });

  it("ignores a skip aimed at a room it is not in", async () => {
    const { responder, created } = harness();
    await responder.handle(add(), "lobby", ada);

    await responder.handle(skip("entry-1"), "studio", ada);
    await responder.handle(remove("entry-1"), "studio", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });
});

describe("when something goes wrong", () => {
  it("survives a refused join and leaves no half-built Set behind", async () => {
    const { responder, created, log } = harness({ failToBegin: "lobby" });

    const answer = await responder.handle(add(), "lobby", ada);

    // Not `extractor_failed`: nothing was wrong with the link, and that
    // sentence sends the member away to wait for YouTube to recover from
    // something YouTube never did.
    assert.deepEqual(answer, { ok: false, error: "bot_failed" });
    assert.equal(responder.currentRoomId(), null);
    assert.deepEqual(created[0]?.events, ["begin", "end"]);
    assert.match(log.join("\n"), /add request for room lobby failed/);
  });

  it("can be summoned again after a failure", async () => {
    const { responder, created } = harness({ failToBegin: "lobby" });

    await responder.handle(add(), "lobby", ada);
    await responder.handle(add(otherLink), "studio", ada);

    assert.equal(responder.currentRoomId(), "studio");
    assert.deepEqual(created[1]?.events, ["begin", "load", "play"]);
  });

  it("handles overlapping commands one at a time", async () => {
    const { responder, created } = harness();

    await Promise.all([
      responder.handle(add(), "lobby", ada),
      responder.handle(add(otherLink), "lobby", ada),
      responder.handle(stop, "lobby", ada)
    ]);

    assert.equal(created.length, 1, "two racing Summons must not build two Sets");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop"], "the second link queued behind the first");
  });

  it("answers every request, including the ones it had to give up on", async () => {
    // The answer is the only route by which a member learns anything at all,
    // so a request that failed must still resolve rather than hang until the
    // server's timeout.
    const { responder } = harness({ failToBegin: "lobby" });

    const answers = await Promise.all([
      responder.handle(add(), "lobby", ada),
      responder.handle(add(otherLink), "lobby", ada)
    ]);

    assert.equal(answers.length, 2);
    for (const answer of answers) assert.equal(typeof answer.ok, "boolean");
  });

  it("ends the Set when an owner disconnects the bot", async () => {
    // Voice moderation applies to the bot as it does to anyone. Holding a Set
    // for a membership the server has dropped would leave peer connections
    // open and make the next Summon into that room play into nothing.
    const { responder, created, forceLeave } = harness();
    await responder.handle(add(), "lobby", ada);

    forceLeave("lobby");
    await responder.handle(add(otherLink), "lobby", ada);

    assert.equal(created.length, 2, "the next Summon rejoins rather than reusing the dropped Set");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "end"]);
  });

  it("ignores an eviction from a room it was not in", async () => {
    const { responder, created, forceLeave } = harness();
    await responder.handle(add(), "lobby", ada);

    forceLeave("studio");
    await responder.handle(stop, "lobby", ada);

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop"]);
  });

  it("stops listening for evictions once it is closed", async () => {
    const { responder, forceLeaveSubscribers } = harness();
    assert.equal(forceLeaveSubscribers(), 1);

    await responder.close();

    assert.equal(forceLeaveSubscribers(), 0);
  });

  it("ends whatever is running when the connection goes away", async () => {
    const { responder, created, cancelled } = harness();
    await responder.handle(add(), "lobby", ada);

    await responder.close();

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "end"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), null);
  });
});
