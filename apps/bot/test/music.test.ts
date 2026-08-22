import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VoiceForceLeaveReason } from "@voxly/shared";
import { createMusicResponder } from "../src/music.js";
import type { MusicSet, MusicSetOptions, SetSocket } from "../src/set.js";

/**
 * The responder is tested against a stand-in Set. What a Set does when it is
 * begun is proven in `set.test.ts` and `mesh.test.ts`; what matters here is
 * which Set exists, and when.
 */

interface FakeSet extends MusicSet {
  readonly events: string[];
}

function harness(options: { failToBegin?: string } = {}) {
  const created: FakeSet[] = [];
  const iceRequests: number[] = [];
  const log: string[] = [];
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
    packets: [Buffer.from([1])],
    loadIceServers: async () => {
      iceRequests.push(Date.now());
      return [];
    },
    createSet: createSet as never,
    log: (message) => log.push(message)
  });

  return {
    responder,
    created,
    iceRequests,
    log,
    forceLeave(roomId: string, reason: VoiceForceLeaveReason = "owner_disconnect") {
      for (const handler of forceLeaveHandlers) handler({ roomId, reason });
    },
    forceLeaveSubscribers: () => forceLeaveHandlers.size
  };
}

describe("being summoned", () => {
  it("joins the room and starts playing", async () => {
    const { responder, created } = harness();

    await responder.handle("play", "lobby");

    assert.equal(created.length, 1);
    assert.deepEqual(created[0]?.events, ["begin", "play"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });

  it("does not rejoin a room it is already in", async () => {
    const { responder, created } = harness();

    await responder.handle("play", "lobby");
    await responder.handle("play", "lobby");

    assert.equal(created.length, 1, "one Summon, one Set");
    assert.deepEqual(created[0]?.events, ["begin", "play", "play"]);
  });

  it("reads the RTC configuration once per Set, not once per request", async () => {
    // TURN credentials are short-lived, so they are fetched when a Set starts —
    // but pressing play again is not a new Set.
    const { responder, iceRequests } = harness();

    await responder.handle("play", "lobby");
    await responder.handle("play", "lobby");

    assert.equal(iceRequests.length, 1);
  });

  it("ends the Set it was running when summoned somewhere else", async () => {
    const { responder, created } = harness();

    await responder.handle("play", "lobby");
    await responder.handle("play", "studio");

    assert.equal(created.length, 2);
    assert.deepEqual(created[0]?.events, ["begin", "play", "end"]);
    assert.deepEqual(created[1]?.events, ["begin", "play"]);
    assert.equal(responder.currentRoomId(), "studio");
  });
});

describe("stopping and leaving", () => {
  it("stops the Track without leaving the room", async () => {
    const { responder, created } = harness();
    await responder.handle("play", "lobby");

    await responder.handle("stop", "lobby");

    assert.deepEqual(created[0]?.events, ["begin", "play", "stop"]);
    assert.equal(responder.currentRoomId(), "lobby", "stopping is not leaving");
  });

  it("leaves the room and forgets the Set", async () => {
    const { responder, created } = harness();
    await responder.handle("play", "lobby");

    await responder.handle("leave", "lobby");

    assert.deepEqual(created[0]?.events, ["begin", "play", "end"]);
    assert.equal(responder.currentRoomId(), null);
  });

  it("ignores a stop aimed at a room it is not in", async () => {
    // A command that raced a move must not silence the Set the asker was never
    // in. It names the room it means, and this is where that is honoured.
    const { responder, created } = harness();
    await responder.handle("play", "lobby");

    await responder.handle("stop", "studio");
    await responder.handle("leave", "studio");

    assert.deepEqual(created[0]?.events, ["begin", "play"]);
    assert.equal(responder.currentRoomId(), "lobby");
  });

  it("does nothing at all when there is no Set to stop", async () => {
    const { responder, created } = harness();

    await responder.handle("stop", "lobby");
    await responder.handle("leave", "lobby");

    assert.deepEqual(created, []);
  });
});

describe("when something goes wrong", () => {
  it("survives a refused join and leaves no half-built Set behind", async () => {
    const { responder, created, log } = harness({ failToBegin: "lobby" });

    await responder.handle("play", "lobby");

    assert.equal(responder.currentRoomId(), null);
    assert.deepEqual(created[0]?.events, ["begin", "end"]);
    assert.match(log[0] ?? "", /play request for room lobby failed/);
  });

  it("can be summoned again after a failure", async () => {
    const { responder, created } = harness({ failToBegin: "lobby" });

    await responder.handle("play", "lobby");
    await responder.handle("play", "studio");

    assert.equal(responder.currentRoomId(), "studio");
    assert.deepEqual(created[1]?.events, ["begin", "play"]);
  });

  it("handles overlapping commands one at a time", async () => {
    const { responder, created } = harness();

    await Promise.all([
      responder.handle("play", "lobby"),
      responder.handle("play", "lobby"),
      responder.handle("stop", "lobby")
    ]);

    assert.equal(created.length, 1, "two racing Summons must not build two Sets");
    assert.deepEqual(created[0]?.events, ["begin", "play", "play", "stop"]);
  });

  it("ends the Set when an owner disconnects the bot", async () => {
    // Voice moderation applies to the bot as it does to anyone. Holding a Set
    // for a membership the server has dropped would leave peer connections
    // open and make the next Summon into that room play into nothing.
    const { responder, created, forceLeave } = harness();
    await responder.handle("play", "lobby");

    forceLeave("lobby");
    await responder.handle("play", "lobby");

    assert.equal(created.length, 2, "the next Summon rejoins rather than reusing the dropped Set");
    assert.deepEqual(created[0]?.events, ["begin", "play", "end"]);
  });

  it("ignores an eviction from a room it was not in", async () => {
    const { responder, created, forceLeave } = harness();
    await responder.handle("play", "lobby");

    forceLeave("studio");
    await responder.handle("stop", "lobby");

    assert.deepEqual(created[0]?.events, ["begin", "play", "stop"]);
  });

  it("stops listening for evictions once it is closed", async () => {
    const { responder, forceLeaveSubscribers } = harness();
    assert.equal(forceLeaveSubscribers(), 1);

    await responder.close();

    assert.equal(forceLeaveSubscribers(), 0);
  });

  it("ends whatever is running when the connection goes away", async () => {
    const { responder, created } = harness();
    await responder.handle("play", "lobby");

    await responder.close();

    assert.deepEqual(created[0]?.events, ["begin", "play", "end"]);
    assert.equal(responder.currentRoomId(), null);
  });
});
