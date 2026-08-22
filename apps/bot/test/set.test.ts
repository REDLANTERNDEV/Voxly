import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  RtcSignal,
  VoiceForceLeaveReason,
  VoiceJoinAck,
  VoiceMediaState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import { createMusicSet, musicBotMedia, type SetSocket } from "../src/set.js";

const roomId = "lobby";
const botUserId = "aaaa-bot";
const packets = [Buffer.from([1, 1]), Buffer.from([2, 2])];

interface Recorder {
  socket: SetSocket;
  joins: Array<{ roomId: string; media: VoiceMediaState }>;
  leaves: string[];
  mediaUpdates: Array<Partial<VoiceMediaState>>;
  snapshotHandlers: number;
  publish: (snapshot: VoiceSnapshot) => void;
}

function recordingSocket(joinAck: VoiceJoinAck = okJoin()): Recorder {
  const joins: Array<{ roomId: string; media: VoiceMediaState }> = [];
  const leaves: string[] = [];
  const mediaUpdates: Array<Partial<VoiceMediaState>> = [];
  const snapshotHandlers = new Set<(snapshot: VoiceSnapshot) => void>();
  const signalHandlers = new Set<(payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void>();
  const forceLeaveHandlers = new Set<(payload: { roomId: string; reason: VoiceForceLeaveReason }) => void>();

  const recorder: Recorder = {
    joins,
    leaves,
    mediaUpdates,
    get snapshotHandlers() {
      return snapshotHandlers.size;
    },
    publish(snapshot) {
      for (const handler of snapshotHandlers) handler(snapshot);
    },
    socket: {
      join(payload, ack) {
        joins.push(payload);
        ack(joinAck);
      },
      leave(id) {
        leaves.push(id);
      },
      setMediaState(payload, ack) {
        mediaUpdates.push(payload.media);
        ack({ ok: true, state: memberState() } satisfies VoiceSetMediaAck);
      },
      onSnapshot(handler) {
        snapshotHandlers.add(handler);
      },
      offSnapshot(handler) {
        snapshotHandlers.delete(handler);
      },
      onForceLeave(handler) {
        forceLeaveHandlers.add(handler);
      },
      offForceLeave(handler) {
        forceLeaveHandlers.delete(handler);
      },
      emit() {
        // Signalling is exercised against real peer connections in mesh.test.ts.
      },
      on(handler) {
        signalHandlers.add(handler);
      },
      off(handler) {
        signalHandlers.delete(handler);
      }
    }
  };
  return recorder;
}

function memberState() {
  return {
    user: { userId: botUserId, nickname: "Music", role: "member" as const, isBot: true },
    media: musicBotMedia,
    moderation: { muted: false, deafened: false }
  };
}

function okJoin(): VoiceJoinAck {
  return { ok: true, state: memberState() };
}

function newSet(recorder: Recorder) {
  return createMusicSet({
    socket: recorder.socket,
    roomId,
    selfUserId: botUserId,
    iceServers: [],
    packets
  });
}

describe("joining a voice room", () => {
  it("arrives with the microphone on and hearing nobody", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);

    await set.begin();

    assert.deepEqual(recorder.joins, [{ roomId, media: musicBotMedia }]);
    // Both matter: the server clamps `speaking` off for a member whose
    // microphone is off, and `deafened` would clamp the microphone in turn.
    assert.equal(musicBotMedia.mic, true);
    assert.equal(musicBotMedia.deafened, false);
    await set.end();
  });

  it("listens for the room's snapshot before joining, not after", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    let handlersAtJoin = 0;
    const original = recorder.socket.join;
    recorder.socket.join = (payload, ack) => {
      handlersAtJoin = recorder.snapshotHandlers;
      original(payload, ack);
    };

    await set.begin();

    assert.equal(handlersAtJoin, 1, "the snapshot the join publishes must not be missed");
    await set.end();
  });

  it("reports a refused join and leaves nothing attached", async () => {
    const recorder = recordingSocket({ ok: false, error: "forbidden" });
    const set = newSet(recorder);

    await assert.rejects(set.begin(), /forbidden/);

    assert.equal(recorder.snapshotHandlers, 0);
    assert.deepEqual(recorder.leaves, [], "a bot that never joined has nothing to leave");
    assert.deepEqual(recorder.mediaUpdates, [], "nor anything to report about itself");
  });
});

describe("the speaking indicator", () => {
  it("lights while the Track plays and clears when it stops", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    set.play();
    set.stop();

    assert.deepEqual(recorder.mediaUpdates, [{ speaking: true }, { speaking: false }]);
    await set.end();
  });

  it("clears before the bot leaves, so the room's last word is not that it was playing", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    set.play();

    await set.end();

    assert.deepEqual(recorder.mediaUpdates, [{ speaking: true }, { speaking: false }]);
    assert.deepEqual(recorder.leaves, [roomId]);
  });

  it("says nothing at all when the Set never played", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    await set.end();

    assert.deepEqual(recorder.mediaUpdates, []);
  });
});

describe("ending a Set", () => {
  it("stops listening to the room and leaves exactly once", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();

    await set.end();
    await set.end();

    assert.equal(recorder.snapshotHandlers, 0);
    assert.deepEqual(recorder.leaves, [roomId]);
  });

  it("ignores a snapshot that arrives after it ended", async () => {
    const recorder = recordingSocket();
    const set = newSet(recorder);
    await set.begin();
    await set.end();

    recorder.publish({
      roomId,
      members: [{
        user: { userId: "ada", nickname: "Ada", role: "member" },
        media: { mic: true, camera: false, screen: false, deafened: false, speaking: false },
        moderation: { muted: false, deafened: false }
      }]
    });

    assert.deepEqual(set.listenerUserIds, []);
  });
});
