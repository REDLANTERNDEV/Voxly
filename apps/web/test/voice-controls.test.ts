import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  controlPresentation,
  createInitialVoiceControls,
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

  it("mutes when deafen is enabled and restores the mic when deafen is disabled", () => {
    const deafened = toggleVoiceControl(createInitialVoiceControls(), "deafen");

    assert.equal(deafened.deafen.on, true);
    assert.equal(deafened.mic.on, false);

    const undeafened = toggleVoiceControl(deafened, "deafen");

    assert.equal(undeafened.deafen.on, false);
    assert.equal(undeafened.mic.on, true);
  });

  it("keeps the mic off after undeafening a receive-only connection", () => {
    const receiveOnly = {
      ...createInitialVoiceControls(),
      mic: { on: false, enabled: true },
      deafen: { on: true, enabled: true }
    };

    const undeafened = toggleVoiceControl(receiveOnly, "deafen", { microphoneAvailable: false });

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
