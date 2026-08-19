import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MediaStreamTrack, RTCPeerConnection } from "werift";
import { VoiceMesh } from "../src/mesh.js";
import type { VoxlySocket } from "../src/voxly.js";

const roomId = "lobby";
const self = "zzz-bot";
const listener = "aaa-listener";

describe("VoiceMesh", () => {
  it("offers to a Listener even when that Listener signalled first", async () => {
    // The reason this matters is FINDINGS.md finding 1: a Listener with no
    // microphone offers no media sections, so the bot's own offer is the only
    // thing that can carry audio. If a signal from that Listener beats the
    // snapshot through the server, the peer already exists by the time the
    // snapshot arrives — and the room goes silent unless the bot offers anyway.
    const socket = fakeSocket();
    const mesh = new VoiceMesh({
      socket: socket as unknown as VoxlySocket,
      roomId,
      selfUserId: self,
      iceServers: [],
      createOutput: () => new MediaStreamTrack({ kind: "audio" })
    });
    mesh.start();

    try {
      socket.deliver("rtc:signal", {
        roomId,
        fromUserId: listener,
        signal: { type: "offer", sdp: await offerWithNoMedia() }
      });
      await until(() => socket.signalsOfType("answer").length > 0, "an answer to the empty offer");

      socket.deliver("voice:snapshot", {
        roomId,
        members: [{ user: { userId: self } }, { user: { userId: listener } }]
      });

      await until(() => socket.signalsOfType("offer").length > 0, "an offer carrying the music");
      const offer = socket.signalsOfType("offer")[0];
      assert.equal(offer?.toUserId, listener);
      assert.ok(mediaSectionCount(offer?.signal.sdp ?? "") > 0, "the bot's offer must carry a media section");
    } finally {
      await mesh.stop();
    }
  });

  it("ignores rooms it is not playing into", async () => {
    const socket = fakeSocket();
    const mesh = new VoiceMesh({
      socket: socket as unknown as VoxlySocket,
      roomId,
      selfUserId: self,
      iceServers: [],
      createOutput: () => new MediaStreamTrack({ kind: "audio" })
    });
    mesh.start();

    try {
      socket.deliver("voice:snapshot", {
        roomId: "another-room",
        members: [{ user: { userId: self } }, { user: { userId: listener } }]
      });
      await pause(150);

      assert.equal(mesh.peers.size, 0);
      assert.equal(socket.sent.length, 0);
    } finally {
      await mesh.stop();
    }
  });
});

/** The SDP a peer with nothing to send produces. Not a fabrication: this is
 *  what a real WebRTC implementation emits with no transceivers. */
async function offerWithNoMedia() {
  const connection = new RTCPeerConnection({});
  await connection.setLocalDescription(await connection.createOffer());
  const sdp = connection.localDescription?.sdp ?? "";
  await connection.close();
  assert.equal(mediaSectionCount(sdp), 0, "fixture should have no media sections");
  return sdp;
}

function mediaSectionCount(sdp: string) {
  return sdp.split("\nm=").length - 1;
}

interface SentSignal {
  toUserId: string;
  signal: { type: string; sdp?: string };
}

function fakeSocket() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  return {
    sent,
    on(event: string, handler: (payload: never) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler as (payload: unknown) => void]);
    },
    off(event: string, handler: (payload: never) => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter((existing) => existing !== handler));
    },
    emit(event: string, payload: unknown) {
      sent.push({ event, payload });
    },
    deliver(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    signalsOfType(type: string) {
      return sent
        .filter((entry) => entry.event === "rtc:signal")
        .map((entry) => entry.payload as SentSignal)
        .filter((payload) => payload.signal.type === type);
    }
  };
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
