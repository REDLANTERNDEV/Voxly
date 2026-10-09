import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScreenRecoveryOwner, type ScreenRecoveryTarget } from "../src/lib/screenRecovery.js";

function harness() {
  let now = 0;
  const repairs: string[] = [];
  const track = { readyState: "live", muted: false } as MediaStreamTrack;
  const peer = {} as RTCPeerConnection;
  let frames = 0;
  const receiver = { track, getStats: async () => new Map([["v", { type: "inbound-rtp", kind: "video", framesDecoded: frames }]]) } as unknown as RTCRtpReceiver;
  const owner = new ScreenRecoveryOwner(async id => { repairs.push(id); }, () => {}, () => now);
  const target: ScreenRecoveryTarget = { publisherId: "publisher", peer, receiver };
  owner.sync([target]);
  return { owner, target, track, repairs, time: (value: number) => { now = value; }, frames: (value: number) => { frames = value; } };
}
describe("ongoing screen recovery", () => {
  it("announces exactly at the grace deadline without waiting for another stats sample", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const h = harness(); const statuses: unknown[] = [];
    const owner = new ScreenRecoveryOwner(async () => {}, status => statuses.push(status));
    owner.sync([h.target]); owner.notePlayback("publisher", h.track);
    owner.sync([{ ...h.target, receiver: null }]);
    t.mock.timers.tick(4_999); assert.equal(owner.status("publisher"), "ready");
    t.mock.timers.tick(1); assert.equal(owner.status("publisher"), "reconnecting");
    owner.sync([h.target]); owner.notePlayback("publisher", h.track);
    owner.sync([{ ...h.target, receiver: null }]); owner.sync([]);
    const count = statuses.length; t.mock.timers.tick(10_000); assert.equal(statuses.length, count);
    owner.dispose(); h.owner.dispose();
  });
  it("keeps previously decoded playback quiet for five seconds across repeated replacements", async () => {
    const h = harness(); h.frames(1); await h.owner.sample();
    h.time(1_000); h.owner.sync([{ ...h.target, peer: {} as RTCPeerConnection, receiver: null }]);
    assert.equal(h.owner.status("publisher"), "ready");
    h.time(4_000); h.owner.sync([{ ...h.target, peer: {} as RTCPeerConnection, receiver: null }]);
    h.time(5_999); await h.owner.sample(); assert.equal(h.owner.status("publisher"), "ready");
    h.time(6_000); await h.owner.sample(); assert.equal(h.owner.status("publisher"), "reconnecting");
    h.owner.sync([h.target]); h.owner.notePlayback("publisher", h.track);
    assert.equal(h.owner.status("publisher"), "ready");
    h.owner.sync([]); h.owner.sync([h.target]); assert.equal(h.owner.status("publisher"), "connecting");
  });
  it("does not announce a brief mute and starts a new grace period after recovery", async () => {
    const h = harness(); h.frames(1); await h.owner.sample();
    Object.assign(h.track, { muted: true }); h.time(1_000); await h.owner.sample();
    h.time(5_000); await h.owner.sample(); assert.equal(h.repairs.length, 1);
    assert.equal(h.owner.status("publisher"), "ready");
    Object.assign(h.track, { muted: false }); h.time(5_500); await h.owner.sample();
    Object.assign(h.track, { muted: true }); h.time(6_000); await h.owner.sample();
    h.time(10_999); await h.owner.sample(); assert.equal(h.owner.status("publisher"), "ready");
    h.time(11_000); await h.owner.sample(); assert.equal(h.owner.status("publisher"), "reconnecting");
  });
  it("repairs missing first frames even when transport is connected, with a cooldown", async () => {
    const h = harness(); h.time(9_999); await h.owner.sample(); assert.equal(h.repairs.length, 0);
    h.time(10_000); await h.owner.sample(); assert.equal(h.repairs.length, 1);
    h.time(12_000); await h.owner.sample(); assert.equal(h.repairs.length, 1);
    h.time(25_000); await h.owner.sample(); assert.equal(h.repairs.length, 2);
  });
  it("accepts decoded frames without confusing a static screen with a stall", async () => {
    const h = harness(); h.frames(1); await h.owner.sample(); h.time(30_000); await h.owner.sample();
    assert.equal(h.repairs.length, 0);
    Object.assign(h.track, { muted: true }); await h.owner.sample(); h.time(34_000); await h.owner.sample();
    assert.equal(h.repairs.length, 1);
  });
  it("cancels on Unwatch or share stop and ignores late statistics", async () => {
    const h = harness(); let finish!: (value: RTCStatsReport) => void;
    h.target.receiver!.getStats = () => new Promise(resolve => { finish = resolve; });
    const pending = h.owner.sample(); h.owner.sync([]); h.time(20_000);
    finish(new Map() as RTCStatsReport); await pending; assert.equal(h.repairs.length, 0);
  });
  it("ignores a replacement's stale playback callback and uses valid playback without stats", async () => {
    const h = harness(); h.target.receiver!.getStats = async () => { throw new Error("unsupported"); };
    const replacement = { ...h.target, peer: {} as RTCPeerConnection, receiver: { ...h.target.receiver, track: { readyState: "live", muted: false } } as RTCRtpReceiver };
    h.owner.sync([replacement]); h.owner.notePlayback("publisher", h.track);
    h.time(10_000); await h.owner.sample(); assert.equal(h.repairs.length, 1);
    h.owner.notePlayback("publisher", replacement.receiver!.track); h.time(30_000); await h.owner.sample();
    assert.equal(h.repairs.length, 1);
  });
  it("invalidates a pending repair across Unwatch and a new Watch of the same peer", async () => {
    let now = 0, finish!: () => void, signals = 0;
    const h = harness();
    const owner = new ScreenRecoveryOwner(async (_id, _peer, isCurrent) => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (isCurrent()) signals++;
    }, () => {}, () => now);
    owner.sync([h.target]); now = 10_000;
    const pending = owner.sample(); await Promise.resolve(); await Promise.resolve();
    owner.sync([]); owner.sync([h.target]); finish(); await pending;
    assert.equal(signals, 0); owner.dispose();
  });
  it("resets the fault budget after a muted track recovers", async () => {
    const h = harness(); h.frames(1); await h.owner.sample();
    Object.assign(h.track, { muted: true }); await h.owner.sample(); h.time(4_000); await h.owner.sample();
    Object.assign(h.track, { muted: false }); h.time(5_000); await h.owner.sample();
    assert.equal(h.owner.status("publisher"), "ready");
    Object.assign(h.track, { readyState: "ended" }); h.time(610_000); await h.owner.sample();
    h.time(614_000); await h.owner.sample(); assert.notEqual(h.owner.status("publisher"), "failed");
    assert.equal(h.repairs.length, 2);
  });
  it("keeps the first-frame deadline through peer replacement", async () => {
    const h = harness(); h.time(9_000); h.owner.sync([{ ...h.target, peer: {} as RTCPeerConnection }]);
    h.time(10_000); await h.owner.sample(); assert.equal(h.repairs.length, 1);
  });
  it("bounds a continuous fault to ten minutes and allows explicit Retry", async () => {
    const h = harness(); h.time(10_000); await h.owner.sample(); h.time(610_000); await h.owner.sample();
    assert.equal(h.owner.status("publisher"), "failed"); assert.equal(h.repairs.length, 1);
    h.owner.retry("publisher"); await h.owner.sample(); assert.equal(h.repairs.length, 2);
    h.owner.dispose(); h.time(700_000); await h.owner.sample(); assert.equal(h.repairs.length, 2);
  });
});
