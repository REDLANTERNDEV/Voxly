import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  controlPresentation,
  createInitialVoiceControls,
  toggleVoiceControl,
  voiceDockStatus,
  voiceStatusLabels
} from "../src/lib/voiceControls.js";
import { createInitialMediaState, mediaConstraintsFor } from "../src/lib/voiceMedia.js";

describe("voice control view state", () => {
  it("keeps camera and screen share off by default but available after joining", () => {
    const controls = createInitialVoiceControls();

    assert.equal(controls.camera.enabled, true);
    assert.equal(controls.screenShare.enabled, true);
    assert.equal(controls.camera.on, false);
    assert.equal(controls.screenShare.on, false);
    assert.equal(toggleVoiceControl(controls, "camera").camera.on, true);
  });

  it("shows muted and deafened dock status from local controls", () => {
    const muted = toggleVoiceControl(createInitialVoiceControls(), "mic");
    const deafened = toggleVoiceControl(createInitialVoiceControls(), "deafen");

    assert.equal(voiceDockStatus(muted, 3), "Mic muted - 3 connected");
    assert.equal(voiceDockStatus(deafened, 3), "Deafened - voice output off");
  });

  it("mutes when deafen is enabled and restores the mic when deafen is disabled", () => {
    const deafened = toggleVoiceControl(createInitialVoiceControls(), "deafen");

    assert.equal(deafened.deafen.on, true);
    assert.equal(deafened.mic.on, false);

    const undeafened = toggleVoiceControl(deafened, "deafen");

    assert.equal(undeafened.deafen.on, false);
    assert.equal(undeafened.mic.on, true);
  });

  it("labels combined mute, deafen, speaking, and screen state", () => {
    assert.deepEqual(
      voiceStatusLabels({ mic: false, camera: true, screen: true, deafened: true, speaking: true }),
      ["Deafened", "Muted", "Screen"]
    );
    assert.deepEqual(
      voiceStatusLabels({ mic: true, camera: false, screen: false, deafened: false, speaking: true }),
      ["Speaking"]
    );
  });

  it("presents muted and deafened controls as attention states with recovery actions", () => {
    const muted = toggleVoiceControl(createInitialVoiceControls(), "mic");
    const deafened = toggleVoiceControl(createInitialVoiceControls(), "deafen");

    assert.deepEqual(controlPresentation("mic", muted), { action: "unmuteMic", tone: "danger" });
    assert.deepEqual(controlPresentation("deafen", deafened), { action: "undeafen", tone: "danger" });
    assert.deepEqual(controlPresentation("mic", createInitialVoiceControls()), { action: "muteMic", tone: "neutral" });
  });

  it("uses low-cost media defaults for small VPS rooms", () => {
    assert.deepEqual(createInitialMediaState(), {
      joined: false,
      mic: false,
      camera: false,
      screen: false,
      error: ""
    });
    assert.deepEqual(mediaConstraintsFor("camera"), {
      video: {
        width: { ideal: 640, max: 640 },
        height: { ideal: 360, max: 360 },
        frameRate: { ideal: 24, max: 24 }
      },
      audio: false
    });
    assert.deepEqual(mediaConstraintsFor("screen"), {
      video: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 15, max: 15 }
      },
      audio: true
    });
  });
});
