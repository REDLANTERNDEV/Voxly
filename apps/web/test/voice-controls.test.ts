import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  controlPresentation,
  createInitialVoiceControls,
  sidebarVoiceStatusKeys,
  toggleVoiceControl,
  voiceDockStatus,
  voiceStatusLabels
} from "../src/lib/voiceControls.js";
import {
  configureScreenTrack,
  createInitialMediaState,
  mediaConstraintsFor,
  preferScreenSenderResolution,
  replaceMicrophoneTrack
} from "../src/lib/voiceMedia.js";

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

  it("restores an open mic after undeafening when a microphone remains available", () => {
    const beforeDeafen = createInitialVoiceControls();
    const deafened = toggleVoiceControl(beforeDeafen, "deafen");

    assert.equal(deafened.deafen.on, true);
    assert.equal(deafened.mic.on, false);

    const restoreOptions = {
      restoreMicrophoneOn: beforeDeafen.mic.on,
      microphoneAvailable: true
    };
    const undeafened = toggleVoiceControl(deafened, "deafen", restoreOptions);

    assert.equal(undeafened.deafen.on, false);
    assert.equal(undeafened.mic.on, true);
  });

  it("keeps a previously muted mic off after undeafening", () => {
    const beforeDeafen = toggleVoiceControl(createInitialVoiceControls(), "mic");
    const deafened = toggleVoiceControl(beforeDeafen, "deafen");
    const restoreOptions = {
      restoreMicrophoneOn: beforeDeafen.mic.on,
      microphoneAvailable: true
    };
    const undeafened = toggleVoiceControl(deafened, "deafen", restoreOptions);

    assert.equal(undeafened.deafen.on, false);
    assert.equal(undeafened.mic.on, false);
  });

  it("keeps the mic off when the previous open mic is no longer available", () => {
    const beforeDeafen = createInitialVoiceControls();
    const deafened = toggleVoiceControl(beforeDeafen, "deafen");
    const restoreOptions = {
      restoreMicrophoneOn: beforeDeafen.mic.on,
      microphoneAvailable: false
    };
    const undeafened = toggleVoiceControl(deafened, "deafen", restoreOptions);

    assert.equal(undeafened.deafen.on, false);
    assert.equal(undeafened.mic.on, false);
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

  it("derives compact sidebar mute and deafen indicators", () => {
    assert.deepEqual(
      sidebarVoiceStatusKeys({ mic: true, camera: false, screen: false, deafened: false, speaking: false }),
      []
    );
    assert.deepEqual(
      sidebarVoiceStatusKeys({ mic: false, camera: false, screen: false, deafened: false, speaking: false }),
      ["muted"]
    );
    assert.deepEqual(
      sidebarVoiceStatusKeys({ mic: false, camera: false, screen: false, deafened: true, speaking: false }),
      ["muted", "deafened"]
    );
  });

  it("presents muted and deafened controls as attention states with recovery actions", () => {
    const muted = toggleVoiceControl(createInitialVoiceControls(), "mic");
    const deafened = toggleVoiceControl(createInitialVoiceControls(), "deafen");

    assert.deepEqual(controlPresentation("mic", muted), { action: "unmuteMic", tone: "neutral" });
    assert.deepEqual(controlPresentation("deafen", deafened), { action: "undeafen", tone: "neutral" });
    assert.deepEqual(controlPresentation("mic", createInitialVoiceControls()), { action: "muteMic", tone: "neutral" });
  });

  it("presents only an active screen share as a danger stop action", () => {
    const inactive = createInitialVoiceControls();
    const active = toggleVoiceControl(inactive, "screenShare");

    assert.deepEqual(controlPresentation("screenShare", inactive), { action: "startScreenShare", tone: "neutral" });
    assert.deepEqual(controlPresentation("screenShare", active), { action: "stopScreenShare", tone: "danger" });
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
        frameRate: { ideal: 30, max: 30 }
      },
      audio: true
    });
  });

  it("preserves screen detail while bandwidth ramps without affecting other tracks", async () => {
    const screenTrack = { kind: "video", contentHint: "" } as MediaStreamTrack;
    const cameraTrack = { kind: "video", contentHint: "" } as MediaStreamTrack;
    let appliedPreference: string | undefined;
    const sender = {
      track: screenTrack,
      getParameters: () => ({}),
      setParameters: async (parameters: RTCRtpSendParameters) => {
        appliedPreference = (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference;
      }
    } as unknown as RTCRtpSender;

    configureScreenTrack(screenTrack);

    assert.equal(screenTrack.contentHint, "detail");
    assert.equal(await preferScreenSenderResolution(sender, screenTrack), true);
    assert.equal(appliedPreference, "maintain-resolution");
    assert.equal(await preferScreenSenderResolution(sender, cameraTrack), false);
  });

  it("keeps screen sharing alive when sender preference is rejected", async () => {
    const screenTrack = { kind: "video", contentHint: "" } as MediaStreamTrack;
    const sender = {
      track: screenTrack,
      getParameters: () => ({}),
      setParameters: async () => {
        throw new Error("unsupported");
      }
    } as unknown as RTCRtpSender;

    assert.equal(await preferScreenSenderResolution(sender, screenTrack), false);
  });

  it("replaces only the previous microphone sender and leaves screen audio untouched", async () => {
    const previousMic = { id: "old-mic" } as MediaStreamTrack;
    const nextMic = { id: "new-mic" } as MediaStreamTrack;
    const screenAudio = { id: "screen-audio" } as MediaStreamTrack;
    const replacements: string[] = [];
    const peers = [{
      getSenders: () => [
        { track: previousMic, replaceTrack: async (track: MediaStreamTrack) => { replacements.push(track.id); } },
        { track: screenAudio, replaceTrack: async () => { throw new Error("screen audio must not change"); } }
      ]
    }];

    assert.equal(await replaceMicrophoneTrack(peers, previousMic, nextMic), 1);
    assert.deepEqual(replacements, ["new-mic"]);
  });
});
