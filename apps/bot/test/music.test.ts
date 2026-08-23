import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MusicCommand, VoiceForceLeaveReason } from "@voxly/shared";
import type { BotEnvironment } from "../src/config.js";
import { createMusicResponder } from "../src/music.js";
import { TrackBuffer } from "../src/audio.js";
import type { MusicSet, MusicSetOptions, SetSocket } from "../src/set.js";
import type { TrackAudio } from "../src/stream.js";
import type { TrackResult } from "../src/track.js";

/**
 * The responder is tested against a stand-in Set, a stand-in extractor and a
 * stand-in fetch. What a Set does when it is begun is proven in `set.test.ts`
 * and `mesh.test.ts`; what a link means is proven in `track.test.ts`. What
 * matters here is the order things happen in and which Set exists when.
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

const add = (url = link): MusicCommand => ({ kind: "add", url });
const play: MusicCommand = { kind: "play" };
const stop: MusicCommand = { kind: "stop" };
const leave: MusicCommand = { kind: "leave" };

function trackFor(id: string) {
  return {
    ok: true as const,
    track: { id, title: `Track ${id}`, durationSeconds: 273, url: `https://www.youtube.com/watch?v=${id}` }
  };
}

interface FakeSet extends MusicSet {
  readonly events: string[];
}

function harness(options: { failToBegin?: string; resolveAs?: TrackResult } = {}) {
  const created: FakeSet[] = [];
  const iceRequests: number[] = [];
  const log: string[] = [];
  const resolved: string[] = [];
  const fetched: string[] = [];
  const cancelled: string[] = [];
  const forceLeaveHandlers = new Set<(payload: { roomId: string; reason: VoiceForceLeaveReason }) => void>();
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

  const responder = createMusicResponder({
    socket,
    selfUserId: "aaaa-bot",
    environment,
    loadIceServers: async () => {
      iceRequests.push(Date.now());
      return [];
    },
    createSet: createSet as never,
    resolve: async (_environment, url) => {
      resolved.push(url);
      return options.resolveAs ?? trackFor(url.slice(-11));
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
    fetched,
    cancelled,
    forceLeave(roomId: string, reason: VoiceForceLeaveReason = "owner_disconnect") {
      for (const handler of forceLeaveHandlers) handler({ roomId, reason });
    },
    forceLeaveSubscribers: () => forceLeaveHandlers.size
  };
}

describe("a pasted link", () => {
  it("summons the bot, loads the Track and starts playing", async () => {
    const { responder, created, fetched } = harness();

    const answer = await responder.handle(add(), "lobby");

    assert.deepEqual(answer, {
      ok: true,
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

    await responder.handle(add("https://youtu.be/aB3dE5gH7jK?si=xyz&t=90"), "lobby");

    assert.deepEqual(resolved, [link]);
  });

  it("refuses a link that is not one video, without spawning anything", async () => {
    const { responder, resolved, created } = harness();

    const answer = await responder.handle(add("https://open.spotify.com/track/4cOdK2wGLETKBW3"), "lobby");

    assert.deepEqual(answer, { ok: false, error: "unsupported_link" });
    assert.deepEqual(resolved, [], "the extractor is never asked about a link it could not use");
    assert.deepEqual(created, [], "and the bot does not appear in the channel to say so");
  });

  it("reports what the extractor said without joining the channel", async () => {
    // A member who pasted a dead link should be told. Summoning first would put
    // a silent bot in the channel that then has to be sent away again.
    for (const error of ["track_unavailable", "live_stream", "extractor_failed"] as const) {
      const { responder, created } = harness({ resolveAs: { ok: false, error } });

      assert.deepEqual(await responder.handle(add(), "lobby"), { ok: false, error });
      assert.deepEqual(created, [], error);
    }
  });

  it("replaces what is playing when another link arrives", async () => {
    // No Queue yet — ticket 08 owns appending. What must not happen is two
    // Tracks writing into the same Listeners at once.
    const { responder, created, fetched, cancelled } = harness();
    await responder.handle(add(), "lobby");

    await responder.handle(add(otherLink), "lobby");

    assert.equal(created.length, 1, "a second Track is not a second Set");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK", "zY9xW7vU5tS"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"], "the abandoned fetch is not left running");
  });

  it("reads the RTC configuration once per Set, not once per Track", async () => {
    // TURN credentials are short-lived, so they are fetched when a Set starts —
    // but adding another Track is not a new Set.
    const { responder, iceRequests } = harness();

    await responder.handle(add(), "lobby");
    await responder.handle(add(otherLink), "lobby");

    assert.equal(iceRequests.length, 1);
  });

  it("ends the Set it was running when summoned somewhere else", async () => {
    const { responder, created, cancelled } = harness();

    await responder.handle(add(), "lobby");
    await responder.handle(add(otherLink), "studio");

    assert.equal(created.length, 2);
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "end"]);
    assert.deepEqual(created[1]?.events, ["begin", "load", "play"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), "studio");
  });
});

describe("stopping and leaving", () => {
  it("stops the Track without leaving the room", async () => {
    const { responder, created } = harness();
    await responder.handle(add(), "lobby");

    assert.deepEqual(await responder.handle(stop, "lobby"), { ok: true, track: null });
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop"]);
    assert.equal(responder.currentRoomId(), "lobby", "stopping is not leaving");
  });

  it("resumes the Track that is already loaded", async () => {
    const { responder, created, fetched } = harness();
    await responder.handle(add(), "lobby");
    await responder.handle(stop, "lobby");

    await responder.handle(play, "lobby");

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "stop", "play"]);
    assert.deepEqual(fetched, ["aB3dE5gH7jK"], "resuming does not fetch the Track again");
  });

  it("leaves the room, forgets the Set and abandons the fetch", async () => {
    const { responder, created, cancelled } = harness();
    await responder.handle(add(), "lobby");

    assert.deepEqual(await responder.handle(leave, "lobby"), { ok: true, track: null });
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "end"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), null);
  });

  it("ignores a stop aimed at a room it is not in", async () => {
    // A command that raced a move must not silence the Set the asker was never
    // in. It names the room it means, and this is where that is honoured.
    const { responder, created } = harness();
    await responder.handle(add(), "lobby");

    await responder.handle(stop, "studio");
    await responder.handle(leave, "studio");

    assert.deepEqual(created[0]?.events, ["begin", "load", "play"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });

  it("succeeds at doing nothing when there is no Set to act on", async () => {
    // Not a failure: there is nothing to stop and nothing anyone needs telling.
    // Only `add` summons, so none of these puts a bot in the channel.
    const { responder, created } = harness();

    for (const command of [play, stop, leave]) {
      assert.deepEqual(await responder.handle(command, "lobby"), { ok: true, track: null });
    }
    assert.deepEqual(created, []);
  });
});

describe("when something goes wrong", () => {
  it("survives a refused join and leaves no half-built Set behind", async () => {
    const { responder, created, log } = harness({ failToBegin: "lobby" });

    const answer = await responder.handle(add(), "lobby");

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

    await responder.handle(add(), "lobby");
    await responder.handle(add(otherLink), "studio");

    assert.equal(responder.currentRoomId(), "studio");
    assert.deepEqual(created[1]?.events, ["begin", "load", "play"]);
  });

  it("handles overlapping commands one at a time", async () => {
    const { responder, created } = harness();

    await Promise.all([
      responder.handle(add(), "lobby"),
      responder.handle(add(otherLink), "lobby"),
      responder.handle(stop, "lobby")
    ]);

    assert.equal(created.length, 1, "two racing Summons must not build two Sets");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "load", "play", "stop"]);
  });

  it("answers every request, including the ones it had to give up on", async () => {
    // The answer is the only route by which a member learns anything at all,
    // so a request that failed must still resolve rather than hang until the
    // server's timeout.
    const { responder } = harness({ failToBegin: "lobby" });

    const answers = await Promise.all([
      responder.handle(add(), "lobby"),
      responder.handle(add(otherLink), "lobby")
    ]);

    assert.equal(answers.length, 2);
    for (const answer of answers) assert.equal(typeof answer.ok, "boolean");
  });

  it("ends the Set when an owner disconnects the bot", async () => {
    // Voice moderation applies to the bot as it does to anyone. Holding a Set
    // for a membership the server has dropped would leave peer connections
    // open and make the next Summon into that room play into nothing.
    const { responder, created, forceLeave } = harness();
    await responder.handle(add(), "lobby");

    forceLeave("lobby");
    await responder.handle(add(otherLink), "lobby");

    assert.equal(created.length, 2, "the next Summon rejoins rather than reusing the dropped Set");
    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "end"]);
  });

  it("ignores an eviction from a room it was not in", async () => {
    const { responder, created, forceLeave } = harness();
    await responder.handle(add(), "lobby");

    forceLeave("studio");
    await responder.handle(stop, "lobby");

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
    await responder.handle(add(), "lobby");

    await responder.close();

    assert.deepEqual(created[0]?.events, ["begin", "load", "play", "end"]);
    assert.deepEqual(cancelled, ["aB3dE5gH7jK"]);
    assert.equal(responder.currentRoomId(), null);
  });
});
