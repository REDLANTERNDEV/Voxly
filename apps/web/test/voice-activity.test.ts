import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVoiceActivityState,
  updateVoiceActivity,
  voiceActivityFloorRms,
  voiceActivityReleaseMs,
  voiceActivitySampleMs,
  voiceActivityThresholds,
  type VoiceActivityState
} from "../src/lib/voiceActivity.js";

/** Feeds a constant level for a stretch of time at the real sampling rate. */
function hold(state: VoiceActivityState, rms: number, ms: number, startAt = 0) {
  let current = state;
  let now = startAt;
  for (let elapsed = 0; elapsed < ms; elapsed += voiceActivitySampleMs) {
    now = startAt + elapsed;
    current = updateVoiceActivity(current, rms, now);
  }
  return { state: current, now };
}

describe("voice activity detection", () => {
  it("starts for quiet audible input and ignores lower idle noise", () => {
    const idle = createVoiceActivityState();

    assert.equal(updateVoiceActivity(idle, voiceActivityFloorRms * 0.5, 0).speaking, false);
    assert.equal(updateVoiceActivity(idle, 0.012, 100).speaking, true);
  });

  it("arms for speech far below the level a fixed threshold required", () => {
    // Regression: the trigger used to sit at 0.012 RMS, which a quiet or
    // distant microphone never reaches, so those users showed as silent.
    const quiet = 0.004;
    const settled = hold(createVoiceActivityState(), 0.0004, 2000).state;

    assert.ok(quiet < 0.012, "the case under test is below the former fixed threshold");
    assert.equal(updateVoiceActivity(settled, quiet, 2000).speaking, true);
  });

  it("keeps a silent capture closed no matter how far the floor falls", () => {
    const settled = hold(createVoiceActivityState(), 0, 4000).state;

    assert.ok(settled.noiseFloor < voiceActivityFloorRms);
    assert.equal(updateVoiceActivity(settled, voiceActivityFloorRms * 0.9, 5000).speaking, false);
  });

  it("raises its trigger point in a noisy room instead of latching open", () => {
    const noise = 0.006;
    const settled = hold(createVoiceActivityState(), noise, 60_000).state;

    assert.ok(settled.noiseFloor > voiceActivityFloorRms, "the floor tracked the room");
    assert.ok(voiceActivityThresholds(settled.noiseFloor).enter > noise, "steady noise alone stops arming");
    assert.equal(updateVoiceActivity(settled, noise * 4, 60_000).speaking, true, "speech over it still arms");
  });

  it("does not let sustained speech drag its own threshold up", () => {
    const speech = 0.08;
    const opened = updateVoiceActivity(createVoiceActivityState(), speech, 0);
    const sustained = hold(opened, speech, 30_000, 100).state;

    assert.equal(sustained.speaking, true, "half a minute of talking does not cut the speaker off");
    assert.ok(
      voiceActivityThresholds(sustained.noiseFloor).exit < speech,
      "the release point stays below the level holding the gate open"
    );
  });

  it("returns to a quiet floor as soon as the speaker pauses", () => {
    const afterSpeech = hold(updateVoiceActivity(createVoiceActivityState(), 0.08, 0), 0.08, 10_000, 100).state;
    const afterPause = hold(afterSpeech, 0.0005, 1000, 10_100).state;

    assert.ok(afterPause.noiseFloor < voiceActivityThresholds(afterSpeech.noiseFloor).exit);
  });

  it("holds through short silence and stops after the release window", () => {
    const speaking = updateVoiceActivity(createVoiceActivityState(), 0.02, 100);
    const refreshed = updateVoiceActivity(speaking, 0.009, 200);

    assert.equal(refreshed.speaking, true);
    assert.equal(refreshed.lastAudibleAt, 200);
    assert.equal(updateVoiceActivity(refreshed, 0, 200 + voiceActivityReleaseMs - 1).speaking, true);
    assert.equal(updateVoiceActivity(refreshed, 0, 200 + voiceActivityReleaseMs).speaking, false);
  });

  it("releases harder than it arms, so a syllable gap does not flicker the ring", () => {
    const thresholds = voiceActivityThresholds(createVoiceActivityState().noiseFloor);

    assert.ok(thresholds.exit < thresholds.enter);
  });

  it("samples often enough that the window covers the gap between ticks", () => {
    // The analyser reads 2048 frames (~43ms at 48kHz) every interval, so
    // consecutive reads overlap rather than leaving audio unexamined.
    assert.ok(voiceActivitySampleMs < 2048 / 48);
  });
});
