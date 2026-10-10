import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VoiceQualityController, type VoiceStatsPeer } from "../src/lib/voiceQualityController.js";

function report(seconds: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "microphone",
    ssrc: 1,
    trackIdentifier: "mic",
    type: "inbound-rtp",
    kind: "audio",
    packetsLost: 0,
    concealedSamples: 0,
    silentConcealedSamples: 0,
    removedSamplesForAcceleration: 0,
    insertedSamplesForDeceleration: 0,
    packetsReceived: seconds * 50,
    jitterBufferEmittedCount: seconds * 48000,
    jitterBufferDelay: seconds * 48000 * 0.04,
    ...overrides
  };
}
function harness() {
  let entries: Record<string, unknown>[] = [report(0)];
  let now = 0;
  const peer = {
    connectionState: "connected",
    getStats: async () => new Map(entries.map((entry, index) => [String(index), entry]))
  } as unknown as RTCPeerConnection;
  let source: VoiceStatsPeer[] = [{ userId: "member", peer, expectingAudio: true, microphoneTrackIds: ["mic"] }];
  const controller = new VoiceQualityController(
    () => source,
    () => now
  );
  return {
    controller,
    peer,
    set source(value: VoiceStatsPeer[]) {
      source = value;
    },
    sample(next: Record<string, unknown>[], at = now + 4000) {
      entries = next;
      now = at;
      return controller.sample();
    }
  };
}

describe("voice quality controller", () => {
  it("measures per stream so a new screen receiver cannot hide broken microphone audio", async () => {
    const h = harness();
    await h.sample([report(1)]);
    const next = await h.sample([
      report(2, { concealedSamples: 4800 }),
      report(100, { id: "screen", ssrc: 2, trackIdentifier: "screen" })
    ]);
    assert.equal(next?.grade, "breaking");
    assert.equal(next?.reading?.concealedMs, 100);
    assert.equal(next?.reading?.bufferMs, 40);
  });
  it("ignores retained stats for a stopped screen receiver", async () => {
    const h = harness();
    h.source = [{ userId: "member", peer: h.peer, microphoneTrackIds: ["mic"], activeAudioTrackIds: ["mic"] }];
    const retired = report(100, { id: "screen", ssrc: 2, trackIdentifier: "screen" });
    await h.sample([report(1), retired]);
    const next = await h.sample([report(2), retired]);
    assert.equal(next?.grade, "clear");
    assert.equal(next?.clearPeers.length, 1);
  });
  it("cannot call absent loss or concealment measurements clear", async () => {
    for (const field of [
      "packetsReceived",
      "packetsLost",
      "concealedSamples",
      "silentConcealedSamples",
      "jitterBufferEmittedCount",
      "jitterBufferDelay",
      "removedSamplesForAcceleration",
      "insertedSamplesForDeceleration"
    ]) {
      const h = harness();
      await h.sample([report(1, { [field]: undefined })]);
      assert.equal((await h.sample([report(2, { [field]: undefined })]))?.grade, "measuring");
    }
  });
  it("rebases when previously missing measurements become available", async () => {
    const h = harness();
    await h.sample([report(1, { concealedSamples: undefined })]);
    const next = await h.sample([report(2, { concealedSamples: 48000 })]);
    assert.equal(next?.grade, "measuring");
    assert.equal(next?.recoveryRequests.length, 0);
  });
  it("requires connected transport evidence before treating absent RTP as stalled speech", async () => {
    const h = harness();
    h.source = [
      {
        userId: "member",
        peer: h.peer,
        expectingAudio: true,
        microphoneTrackIds: ["mic"],
        activeAudioTrackIds: ["mic"]
      }
    ];
    const transport = { type: "candidate-pair", id: "pair", state: "succeeded", nominated: true };
    const reportOnly = [transport];
    await h.sample(reportOnly);
    const first = await h.sample(reportOnly);
    assert.equal(first?.symptom, "gaps");
    assert.equal(first?.recoveryRequests.length, 0);
    assert.equal((await h.sample(reportOnly))?.recoveryRequests.length, 1);
  });
  it("does not report clear until each receiver has a usable baseline", async () => {
    const h = harness();
    await h.sample([report(1)]);
    const next = await h.sample([report(2), report(100, { id: "screen", ssrc: 2 })]);
    assert.equal(next?.grade, "measuring");
    assert.equal(next?.clearPeers.length, 0);
  });
  it("rebases a changed SSRC, track or reset counters without recovery", async () => {
    for (const change of [{ ssrc: 2 }, { trackIdentifier: "replacement" }, { packetsReceived: 1 }]) {
      const h = harness();
      await h.sample([report(1)]);
      const next = await h.sample([report(2, { concealedSamples: 48000, ...change })]);
      assert.equal(next?.grade, "measuring");
      assert.equal(next?.recoveryRequests.length, 0);
    }
  });
  it("keeps a missing decoder counter unknown instead of clear", async () => {
    const h = harness();
    await h.sample([report(1, { jitterBufferEmittedCount: undefined })]);
    assert.equal((await h.sample([report(2, { jitterBufferEmittedCount: undefined })]))?.grade, "measuring");
  });
  it("requires consecutive severe samples and retains cooldown through peer replacement", async () => {
    const h = harness();
    await h.sample([report(0)], 0);
    assert.equal(
      (await h.sample([report(1, { removedSamplesForAcceleration: 5760 })], 4000))?.recoveryRequests.length,
      0
    );
    assert.equal(
      (await h.sample([report(2, { removedSamplesForAcceleration: 11520 })], 8000))?.recoveryRequests.length,
      1
    );
    const replacement = { connectionState: "connected", getStats: h.peer.getStats } as RTCPeerConnection;
    h.source = [{ userId: "member", peer: replacement, expectingAudio: true }];
    await h.sample([report(0)], 9000);
    await h.sample([report(1, { concealedSamples: 5760 })], 13000);
    assert.equal((await h.sample([report(2, { concealedSamples: 11520 })], 17000))?.recoveryRequests.length, 0);
    assert.equal((await h.sample([report(3, { concealedSamples: 17280 })], 23000))?.recoveryRequests.length, 1);
  });
  it("a missing measurement breaks the consecutive failure streak", async () => {
    const h = harness();
    await h.sample([report(0)]);
    await h.sample([report(1, { concealedSamples: 5760 })]);
    await h.sample([]);
    await h.sample([report(2, { concealedSamples: 11520 })]);
    assert.equal((await h.sample([report(3, { concealedSamples: 17280 })]))?.recoveryRequests.length, 0);
  });
  it("does not interpret a silent screen as stalled speech", async () => {
    const h = harness();
    const screen = report(1, { id: "screen", ssrc: 2, trackIdentifier: "screen" });
    await h.sample([report(1), screen]);
    await h.sample([report(2), screen]);
    const next = await h.sample([report(3), screen]);
    assert.equal(next?.recoveryRequests.length, 0);
    assert.equal(next?.grade, "measuring");
  });
  it("shows a speech stall as breaking instead of clear/measuring", async () => {
    const h = harness();
    await h.sample([report(1)]);
    const next = await h.sample([report(1)]);
    assert.equal(next?.grade, "breaking");
    assert.equal(next?.symptom, "gaps");
    assert.equal((await h.sample([report(1)]))?.recoveryRequests.length, 1);
  });
  it("ignores results from a replaced connection and keeps sampling single-flight", async () => {
    const h = harness();
    let resolve!: (value: RTCStatsReport) => void;
    h.peer.getStats = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = h.controller.sample();
    assert.equal(await h.controller.sample(), null);
    h.source = [];
    resolve(new Map() as RTCStatsReport);
    const next = await pending;
    assert.equal(next?.clearPeers.length, 0);
    assert.equal(next?.recoveryRequests.length, 0);
    assert.equal(next?.grade, "measuring");
  });
  it("disposal invalidates an in-flight sample", async () => {
    const h = harness();
    let resolve!: (value: RTCStatsReport) => void;
    h.peer.getStats = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = h.controller.sample();
    h.controller.dispose();
    resolve(new Map() as RTCStatsReport);
    assert.equal(await pending, null);
  });
  it("reports recovery only from the media owner's actual state", async () => {
    const h = harness();
    h.source = [{ userId: "member", peer: h.peer, recovering: true }];
    assert.equal((await h.sample([report(1)]))?.recovering, true);
  });
});
