import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCaptureOwner, probeConstraints, screenConstraints, summarizeTracks, transitionWithMediaCleanup } from "../src/media.js";
import { english, turkish, errorKey } from "../src/i18n.js";

function streamFixture() {
  let stops = 0;
  const track = {
    kind: "audio", readyState: "live", enabled: true, muted: false,
    label: "Private microphone name",
    getSettings: () => ({ deviceId: "secret-device", groupId: "secret-group", sampleRate: 48000, echoCancellation: true, restrictOwnAudio: false }),
    stop: () => { stops += 1; }
  } as unknown as MediaStreamTrack;
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, stops: () => stops };
}

describe("desktop feasibility probes", () => {
  it("stops a capture that resolves after cancellation", () => {
    const owner = createCaptureOwner();
    const late = streamFixture();
    const ticket = owner.begin();
    owner.stop();
    assert.equal(owner.accept(ticket, late.stream), false);
    assert.equal(late.stops(), 1);
    assert.equal(owner.current(), null);
  });

  it("releases the earlier probe and rejects its late completion", () => {
    const owner = createCaptureOwner();
    const first = streamFixture();
    const late = streamFixture();
    const next = streamFixture();
    const ticket = owner.begin();
    assert.equal(owner.accept(ticket, first.stream), true);
    const replacement = owner.begin();
    assert.equal(first.stops(), 1);
    assert.equal(owner.accept(ticket, late.stream), false);
    assert.equal(late.stops(), 1);
    assert.equal(owner.accept(replacement, next.stream), true);
    owner.stop();
    owner.stop();
    assert.equal(next.stops(), 1);
  });

  it("ends probes and late permission results before a confirmed transition", async () => {
    const owner = createCaptureOwner();
    const live = streamFixture();
    const late = streamFixture();
    const ticket = owner.begin();
    owner.accept(ticket, live.stream);
    await assert.rejects(transitionWithMediaCleanup(owner.stop, async () => {
      assert.equal(live.stops(), 1);
      assert.equal(owner.accept(ticket, late.stream), false);
      throw new Error("installation unreachable");
    }), /installation unreachable/);
    assert.equal(late.stops(), 1);
    assert.equal(owner.current(), null);
  });

  it("tracks pending chooser probes without letting an old failure clear a replacement", () => {
    const owner = createCaptureOwner();
    const old = owner.begin();
    const replacement = owner.begin();
    owner.finish(old);
    assert.equal(owner.isPending(), true);
    owner.accept(replacement, streamFixture().stream);
    assert.equal(owner.isPending(), false);
    const failed = owner.begin();
    owner.finish(failed);
    assert.equal(owner.isPending(), false);
    owner.begin(); owner.stop();
    assert.equal(owner.isPending(), false);
  });

  it("excludes Device identifiers and capture labels from diagnostics", () => {
    assert.deepEqual(summarizeTracks(streamFixture().stream), [{
      kind: "audio", readyState: "live", enabled: true, muted: false,
      settings: { sampleRate: 48000, echoCancellation: true, restrictOwnAudio: false }
    }]);
  });

  it("requests microphone processing without claiming it was applied", () => {
    assert.deepEqual(probeConstraints("microphone"), { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    assert.equal(probeConstraints("camera").audio, false);
  });

  it("requests own-audio exclusion optionally without microphone processing", () => {
    assert.deepEqual(screenConstraints.audio, { restrictOwnAudio: true });
  });

  it("provides matching Turkish keys and never renders native error internals", () => {
    assert.deepEqual(Object.keys(turkish).sort(), Object.keys(english).sort());
    assert.equal(errorKey("https_required"), "https_required");
    assert.equal(errorKey("unexpected error containing a token"), "unknownError");
    assert.equal(errorKey(new Error("private path")), "unknownError");
    assert.equal(errorKey("toString"), "unknownError");
  });
});
