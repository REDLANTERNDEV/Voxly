import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initialScreenQuality, stepScreenQuality, screenSenderSample, stepScreenConnectionWarning } from "../src/lib/screenQuality.js";
import { ScreenQualityController, ScreenQualityOwner } from "../src/lib/screenQualityController.js";
import { safeScreenStats } from "../src/lib/voiceDiagnostics.js";

function harness() {
  const profiles: RTCRtpSendParameters[] = [];
  const track = { kind: "video", readyState: "live", getSettings: () => ({ width: 1280, height: 720 }), addEventListener() {}, removeEventListener() {} } as unknown as MediaStreamTrack;
  const sender = { track, getParameters: () => ({ encodings: [{}] }),
    setParameters: async (parameters: RTCRtpSendParameters) => { profiles.push(parameters); },
    getStats: async () => new Map([["video", { type: "outbound-rtp", kind: "video" }]])
  } as unknown as RTCRtpSender;
  return { track, sender, profiles };
}
describe("screen quality", () => {
  it("promotes startup after two usable samples and requires three samples after congestion", () => {
    let state = stepScreenQuality(initialScreenQuality(), {});
    assert.equal(state.profile, "startup");
    state = stepScreenQuality(state, {}); assert.equal(state.profile, "high");
    state = stepScreenQuality(state, { loss: .12 }); assert.equal(state.profile, "startup");
    state = stepScreenQuality(state, {}); state = stepScreenQuality(state, {}); assert.equal(state.profile, "startup");
    state = stepScreenQuality(state, {}); assert.equal(state.profile, "high");
  });
  it("limits sustained congestion, capacity and profile bounds", () => {
    let state = stepScreenQuality(initialScreenQuality(), { bandwidthLimited: true });
    assert.equal(state.profile, "startup");
    state = stepScreenQuality(state, { bandwidthLimited: true });
    state = stepScreenQuality(state, { bandwidthLimited: true }); assert.equal(state.profile, "low");
    for (let i = 0; i < 10; i++) state = stepScreenQuality(state, { loss: .5 });
    assert.equal(state.profile, "low");
    for (let i = 0; i < 10; i++) state = stepScreenQuality(state, { availableBitrate: 1_000_000 });
    assert.equal(state.profile, "low");
  });
  it("links only the sender's remote and selected transport measurements", () => {
    assert.deepEqual(screenSenderSample([
      { type: "outbound-rtp", kind: "video", remoteId: "r", transportId: "t" },
      { id: "r", type: "remote-inbound-rtp", fractionLost: .02, roundTripTime: .1 },
      { id: "t", type: "transport", selectedCandidatePairId: "p" },
      { id: "p", type: "candidate-pair", availableOutgoingBitrate: 3_000_000 }
    ]), { loss: .02, rttMs: 100, availableBitrate: 3_000_000, bandwidthLimited: false });
    assert.equal(screenSenderSample([{ type: "outbound-rtp", kind: "audio" }]), null);
  });
  it("warns after two bad samples, clears after three healthy samples, and does not invent missing readings", () => {
    let state = { warning: false, bad: 0, healthy: 0 };
    state = stepScreenConnectionWarning(state, { loss: .05 }); assert.equal(state.warning, false);
    state = stepScreenConnectionWarning(state, { rttMs: 300 }); assert.equal(state.warning, true);
    state = stepScreenConnectionWarning(state, null); assert.equal(state.warning, true);
    state = stepScreenConnectionWarning(state, { loss: 0 }); state = stepScreenConnectionWarning(state, { loss: 0 });
    assert.equal(state.warning, true); state = stepScreenConnectionWarning(state, { loss: 0 }); assert.equal(state.warning, false);
  });
  it("applies isolated profiles and falls back when stats are unavailable", async () => {
    const { sender, track, profiles } = harness();
    sender.getStats = async () => { throw new Error("unsupported"); };
    const controller = new ScreenQualityController(sender, track, () => true);
    await controller.sample(false); await controller.sample(); await controller.sample();
    assert.equal(profiles[0].encodings[0].scaleResolutionDownBy, 1);
    assert.equal(profiles[0].encodings[0].maxFramerate, 15);
    assert.equal((profiles[0] as RTCRtpSendParameters & { degradationPreference: string }).degradationPreference, "maintain-resolution");
    assert.equal(profiles[1].encodings[0].scaleResolutionDownBy, 1);
    controller.dispose(); await controller.sample(); assert.equal(profiles.length, 2);
  });
  it("does not retry rejected parameters or apply late stats after disposal", async () => {
    const a = harness(); let attempts = 0;
    a.sender.setParameters = async () => { attempts++; throw new Error("unsupported"); };
    const rejected = new ScreenQualityController(a.sender, a.track, () => true);
    await rejected.sample(); await rejected.sample(); assert.equal(attempts, 1);
    const b = harness(); const controller = new ScreenQualityController(b.sender, b.track, () => true);
    await controller.sample(false); await controller.sample();
    let resolve!: (report: RTCStatsReport) => void;
    b.sender.getStats = () => new Promise(done => { resolve = done; });
    const pending = controller.sample(); controller.dispose(); resolve(new Map([["video", { type: "outbound-rtp", kind: "video" }]]) as unknown as RTCStatsReport);
    await pending; assert.equal(b.profiles.length, 1);
  });
  it("reuses a viewer generation and releases it on unsubscribe", async () => {
    const a = harness(), owner = new ScreenQualityOwner(); const peer = { connectionState: "connected" } as RTCPeerConnection;
    owner.sync("viewer", peer, a.sender, a.track); await new Promise(resolve => setTimeout(resolve, 0));
    owner.sync("viewer", peer, a.sender, a.track); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(a.profiles.length, 1); owner.sync("viewer", peer, null, null); owner.clear();
  });
  it("reduces only the congested viewer and restores quality after sustained healthy measurements", async () => {
    const healthy = harness(), constrained = harness();
    let congested = true;
    healthy.sender.getStats = async () => new Map([["v", { id: "v", type: "outbound-rtp", kind: "video", remoteId: "r" }], ["r", { id: "r", type: "remote-inbound-rtp", fractionLost: 0, roundTripTime: .05 }]]) as unknown as RTCStatsReport;
    constrained.sender.getStats = async () => new Map([["v", { id: "v", type: "outbound-rtp", kind: "video", remoteId: "r" }], ["r", { id: "r", type: "remote-inbound-rtp", fractionLost: congested ? .2 : 0, roundTripTime: .05 }]]) as unknown as RTCStatsReport;
    const a = new ScreenQualityController(healthy.sender, healthy.track, () => true);
    const b = new ScreenQualityController(constrained.sender, constrained.track, () => true);
    for (let i = 0; i < 4; i++) { await a.sample(); await b.sample(); }
    assert.equal(healthy.profiles.at(-1)!.encodings[0].maxFramerate, 30);
    assert.equal(healthy.profiles.at(-1)!.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(constrained.profiles.at(-1)!.encodings[0].scaleResolutionDownBy, 2);
    congested = false;
    for (let i = 0; i < 6; i++) await b.sample();
    assert.equal(constrained.profiles.at(-1)!.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(constrained.profiles.at(-1)!.encodings[0].maxFramerate, 30);
    a.dispose(); b.dispose();
  });
  it("exports only allowlisted video measurements", () => {
    const stats = safeScreenStats([{ type: "outbound-rtp", kind: "video", frameWidth: 1280, id: "secret", trackIdentifier: "secret", sdp: "secret", qualityLimitationReason: "bandwidth" }]);
    assert.deepEqual(stats, [{ type: "outbound-rtp", frameWidth: 1280, qualityLimitationReason: "bandwidth" }]);
  });
});
