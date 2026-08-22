import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VoiceSnapshot } from "@voxly/shared";
import type { RtpPacket } from "werift";
import { readOggOpus, bundledTrackPath } from "../src/audio.js";
import { VoiceMesh } from "../src/mesh.js";
import { TrackPlayer } from "../src/player.js";
import { FakeListener, SignalRelay, until } from "./listener.js";
import { readFileSync } from "node:fs";

/**
 * These are real peer connections: real DTLS, real SRTP, real Opus payloads
 * over loopback. They are slower than a unit test and they earn it, because
 * every interesting failure in this feature lives in the negotiation rather
 * than in the arithmetic. The spike proved a browser hears this; what has to be
 * held from here on is that it keeps hearing it whichever side offers, with
 * more than one Listener, and when Listeners come and go mid-Track.
 */

const roomId = "lobby";
const track = readOggOpus(readFileSync(bundledTrackPath));

/** Ids chosen so the shared tie-break sends the offer the way each test needs. */
const botBelow = "aaaa-bot";
const botAbove = "zzzz-bot";
const listenerMiddle = "mmmm-listener";
const secondListenerMiddle = "nnnn-listener";

/**
 * The frames both Listeners received, paired by RTP timestamp. werift rewrites
 * sequence numbers and ssrc per sender but leaves the timestamp offset stable
 * per stream, so the timestamp difference between two frames identifies the
 * same moment of the Track on either side.
 */
function matchingFrames(left: RtpPacket[], right: RtpPacket[]): Array<[RtpPacket, RtpPacket]> {
  const leftOrigin = left[0]?.header.timestamp;
  const rightOrigin = right[0]?.header.timestamp;
  if (leftOrigin === undefined || rightOrigin === undefined) return [];
  const rightByOffset = new Map(right.map((packet) => [packet.header.timestamp - rightOrigin, packet]));
  return left.flatMap((packet) => {
    const match = rightByOffset.get(packet.header.timestamp - leftOrigin);
    return match ? [[packet, match] as [RtpPacket, RtpPacket]] : [];
  });
}

function snapshotOf(...userIds: string[]): VoiceSnapshot {
  return {
    roomId,
    members: userIds.map((userId) => ({
      user: { userId, nickname: userId, role: "member" as const },
      media: { mic: true, camera: false, screen: false, deafened: false, speaking: false },
      moderation: { muted: false, deafened: false }
    }))
  };
}

interface Harness {
  mesh: VoiceMesh;
  player: TrackPlayer;
  relay: SignalRelay;
  listeners: FakeListener[];
  close: () => Promise<void>;
}

function startBot(selfUserId: string): Harness {
  const relay = new SignalRelay(roomId);
  const player = new TrackPlayer(track.packets);
  const listeners: FakeListener[] = [];
  const mesh = new VoiceMesh({
    signalling: relay.endpointFor(selfUserId),
    roomId,
    selfUserId,
    iceServers: [],
    createOutput: (peerUserId) => player.outputFor(peerUserId),
    onListenerConnected: (peerUserId) => player.startTalkspurt(peerUserId),
    onPeerRemoved: (peerUserId) => player.release(peerUserId)
  });
  mesh.start();
  return {
    mesh,
    player,
    relay,
    listeners,
    async close() {
      player.close();
      await mesh.stop();
      await Promise.all(listeners.map((listener) => listener.close()));
    }
  };
}

describe("a Listener hears the bot", () => {
  it("when the bot is the one the tie-break asks to offer", async () => {
    const bot = startBot(botBelow);
    const listener = new FakeListener({ relay: bot.relay, userId: listenerMiddle, peerUserId: botBelow });
    bot.listeners.push(listener);

    try {
      bot.mesh.applySnapshot(snapshotOf(botBelow, listenerMiddle));
      await listener.announce();
      bot.player.start();

      await until(() => listener.received.length > 20, "audio at the Listener");
      assert.ok(listener.received.every((packet) => packet.payload.length > 0));
    } finally {
      await bot.close();
    }
  });

  it("when the Listener offers first and has no microphone to offer with", async () => {
    // The half of the coin flip the spike found broken. The client now always
    // offers a recvonly audio section, and the bot's answer has to turn that
    // into audio flowing the other way — an answer that only received would be
    // a connection that looked healthy and carried nothing.
    const bot = startBot(botAbove);
    const listener = new FakeListener({ relay: bot.relay, userId: listenerMiddle, peerUserId: botAbove });
    bot.listeners.push(listener);

    try {
      bot.mesh.applySnapshot(snapshotOf(botAbove, listenerMiddle));
      await listener.announce();
      bot.player.start();

      await until(() => listener.received.length > 20, "audio at a mic-less Listener that offered first");
    } finally {
      await bot.close();
    }
  });

  it("when it joins after the Track is already playing", async () => {
    const bot = startBot(botBelow);
    const first = new FakeListener({ relay: bot.relay, userId: listenerMiddle, peerUserId: botBelow });
    bot.listeners.push(first);

    try {
      bot.mesh.applySnapshot(snapshotOf(botBelow, listenerMiddle));
      await first.announce();
      bot.player.start();
      await until(() => first.received.length > 20, "audio at the first Listener");

      const late = new FakeListener({ relay: bot.relay, userId: secondListenerMiddle, peerUserId: botBelow });
      bot.listeners.push(late);
      bot.mesh.applySnapshot(snapshotOf(botBelow, listenerMiddle, secondListenerMiddle));
      await late.announce();

      await until(() => late.received.length > 20, "audio at the Listener who arrived late");
      assert.equal(late.received[0]?.header.marker, true, "a late Listener needs a talkspurt marker to sync to");
    } finally {
      await bot.close();
    }
  });
});

describe("more than one Listener", () => {
  it("hears the same Track at once, and one leaving does not interrupt the other", async () => {
    const bot = startBot(botBelow);
    const first = new FakeListener({ relay: bot.relay, userId: listenerMiddle, peerUserId: botBelow });
    const second = new FakeListener({ relay: bot.relay, userId: secondListenerMiddle, peerUserId: botBelow });
    bot.listeners.push(first, second);

    try {
      bot.mesh.applySnapshot(snapshotOf(botBelow, listenerMiddle, secondListenerMiddle));
      await Promise.all([first.announce(), second.announce()]);
      bot.player.start();

      await until(() => first.received.length > 20 && second.received.length > 20, "audio at both Listeners");
      assert.deepEqual(bot.mesh.listenerUserIds.sort(), [listenerMiddle, secondListenerMiddle].sort());

      // Both are fed from one encoded Track, so the payloads they receive are
      // the same bytes even though the RTP headers around them are not. Matched
      // on the RTP timestamp rather than on arrival order: the two connections
      // come up moments apart, so the nth packet each received is not the same
      // frame of the Track.
      const shared = matchingFrames(first.received, second.received);
      assert.ok(shared.length > 10, `expected overlapping frames, got ${shared.length}`);
      for (const [a, b] of shared) {
        assert.deepEqual(a.payload, b.payload, "the same frame must carry the same bytes to both");
        assert.notEqual(a.header.ssrc, b.header.ssrc, "but each Listener has its own stream");
      }

      bot.mesh.applySnapshot(snapshotOf(botBelow, secondListenerMiddle));
      await until(() => bot.mesh.listenerUserIds.length === 1, "the departed Listener to be dropped");
      const before = second.received.length;

      await until(() => second.received.length > before + 20, "audio still reaching the Listener who stayed");
    } finally {
      await bot.close();
    }
  });
});

describe("the mesh's own bookkeeping", () => {
  it("ignores a room it is not playing into", async () => {
    const bot = startBot(botBelow);
    try {
      bot.mesh.applySnapshot({ ...snapshotOf(botBelow, listenerMiddle), roomId: "another-room" });

      assert.deepEqual(bot.mesh.listenerUserIds, []);
    } finally {
      await bot.close();
    }
  });

  it("offers to a Listener whose signal beat the snapshot through the server", async () => {
    // Keying the offer on "this peer is new" instead of "we have offered" is
    // the trap the spike fell into: a stray candidate creates the peer, the
    // snapshot then finds nothing to do, and the room stays silent.
    const bot = startBot(botBelow);
    const listener = new FakeListener({ relay: bot.relay, userId: listenerMiddle, peerUserId: botBelow });
    bot.listeners.push(listener);

    try {
      bot.relay.endpointFor(listenerMiddle).emit({
        roomId,
        toUserId: botBelow,
        signal: { type: "candidate", candidate: { candidate: "", sdpMid: "0", sdpMLineIndex: 0 } }
      });
      await until(() => bot.mesh.listenerUserIds.length === 1, "the peer the stray candidate created");

      bot.mesh.applySnapshot(snapshotOf(botBelow, listenerMiddle));
      bot.player.start();

      await until(() => listener.received.length > 20, "audio despite the peer already existing");
    } finally {
      await bot.close();
    }
  });
});
