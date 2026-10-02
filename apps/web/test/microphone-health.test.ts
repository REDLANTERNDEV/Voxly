import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { stepMicrophoneHealth,type MicrophoneHealthState,type MicrophoneHealthSample } from "../src/lib/microphoneHealth.js";
const healthy: MicrophoneHealthSample = { expected: true, visible: true, live: true, unavailable: false, contextState: "running", now: 0 };
const empty: MicrophoneHealthState = { faultSince: null, warning: false };
describe("microphone capture health", () => {
  it("never diagnoses silence as failure, even after hours of zero input", () => {
    let state = empty;
    for (let now = 0; now < 3_600_000; now += 1_000) state = stepMicrophoneHealth(state, { ...healthy, now });
    assert.deepEqual(state, empty);
  });
  it("debounces unavailable capture and clears when the track recovers", () => {
    const muted = { ...healthy, unavailable: true };
    const pending = stepMicrophoneHealth(empty, muted);
    assert.equal(stepMicrophoneHealth(pending, { ...muted, now: 4_999 }).warning, false);
    const warning = stepMicrophoneHealth(pending, { ...muted, now: 5_000 });
    assert.equal(warning.warning, true);
    assert.deepEqual(stepMicrophoneHealth(warning, { ...healthy, now: 5_001 }), empty);
  });
  it("reports ended capture immediately and suspended processing only after five seconds", () => {
    assert.equal(stepMicrophoneHealth(empty, { ...healthy, live: false }).warning, true);
    const sample = { ...healthy, contextState: "suspended" };
    const state = stepMicrophoneHealth(empty, sample);
    assert.equal(state.warning, false);
    assert.equal(stepMicrophoneHealth(state, { ...sample, now: 5_000 }).warning, true);
  });
  it("resets during intentional mute, background suspension, or device replacement", () => {
    const warning = { faultSince: 0, warning: true };
    assert.deepEqual(stepMicrophoneHealth(warning, { ...healthy, expected: false }), empty);
    assert.deepEqual(stepMicrophoneHealth(warning, { ...healthy, visible: false, contextState: "interrupted" }), empty);
    assert.deepEqual(stepMicrophoneHealth(warning, healthy), empty);
  });
});
