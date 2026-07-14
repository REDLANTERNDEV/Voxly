import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVoiceActivityState,
  updateVoiceActivity
} from "../src/lib/voiceActivity.js";

describe("voice activity detection", () => {
  it("starts for quiet audible input and ignores lower idle noise", () => {
    const idle = createVoiceActivityState();

    assert.deepEqual(updateVoiceActivity(idle, 0.009, 0), idle);
    assert.deepEqual(updateVoiceActivity(idle, 0.012, 100), {
      lastAudibleAt: 100,
      speaking: true
    });
  });

  it("holds through short silence and stops after the release window", () => {
    const speaking = updateVoiceActivity(createVoiceActivityState(), 0.02, 100);
    const refreshed = updateVoiceActivity(speaking, 0.009, 200);

    assert.equal(refreshed.speaking, true);
    assert.equal(refreshed.lastAudibleAt, 200);
    assert.equal(updateVoiceActivity(refreshed, 0.002, 549).speaking, true);
    assert.deepEqual(updateVoiceActivity(refreshed, 0.002, 550), {
      lastAudibleAt: 200,
      speaking: false
    });
  });

  it("returns the same state object while the public speaking flag is unchanged", () => {
    const idle = createVoiceActivityState();
    const stillIdle = updateVoiceActivity(idle, 0.001, 100);
    const speaking = updateVoiceActivity(idle, 0.02, 200);
    const stillSpeaking = updateVoiceActivity(speaking, 0.02, 300);

    assert.equal(stillIdle, idle);
    assert.equal(stillSpeaking.speaking, true);
  });
});
