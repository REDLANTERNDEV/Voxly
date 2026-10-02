import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceDock } from "../src/components/shell/VoiceDock.js";
import { VoiceRoomScreen } from "../src/features/voice/VoiceRoomScreen.js";
import { createInitialVoiceControls } from "../src/lib/voiceControls.js";

function fixture(mic: boolean, manualMic = true) {
  const controls = createInitialVoiceControls();
  controls.mic.on = manualMic;
  return {
    user: { id: "self", nickname: "Me", role: "member" }, currentNickname: "Me",
    activeServerId: "server", servers: [], activeVoiceRoomId: "room",
    currentRoom: { id: "room", name: "Room", kind: "voice" },
    route: { name: "voice", roomId: "room" }, rooms: { text: [], voice: [] },
    controls, socketState: "live", microphoneTestActive: false, micLockedByRoom: false,
    voiceModeration: { muted: false, deafened: false },
    voiceSnapshots: { room: { roomId: "room", viewerInVoiceRoom: true, members: [{
      user: { userId: "self", nickname: "Me", role: "member" },
      media: { mic, camera: false, screen: false, deafened: false, speaking: false },
      moderation: { muted: false, deafened: false }
    }] } },
    connectionHealth: { quality: "good", rttMs: 10 },
    voiceQuality: { grade: "measuring", symptom: "none" }, connectedCount: 1,
    remoteStreams: [], localPreviews: [], visualTargets: [], roomHistory: {},
    musicQueues: {}, screenVolumes: {}, audioLevels: { output: 100 },
    t: (key: string) => key
  };
}

function render(mic: boolean, manualMic = true) {
  const props = fixture(mic, manualMic);
  return {
    dock: renderToStaticMarkup(createElement(VoiceDock, props as unknown as ComponentProps<typeof VoiceDock>)),
    stage: renderToStaticMarkup(createElement(VoiceRoomScreen, props as unknown as ComponentProps<typeof VoiceRoomScreen>))
  };
}

describe("hold microphone presentation", () => {
  for (const mode of ["push to talk while released", "push to mute while held"]) {
    it(`shows silence in the dock and stage for ${mode} without changing manual mute`, () => {
      const { dock, stage } = render(false);
      const micButton = dock.match(/<button[^>]*aria-label="common.muteMic"[^>]*>/)?.[0] ?? "";
      assert.match(micButton, /is-self-off/);
      assert.match(micButton, /aria-pressed="true"/);
      assert.match(stage, /aria-label="common.muted"/);
    });
  }

  it("clears silence when publication opens", () => {
    const { dock, stage } = render(true);
    const micButton = dock.match(/<button[^>]*aria-label="common.muteMic"[^>]*>/)?.[0] ?? "";
    assert.doesNotMatch(micButton, /is-self-off/);
    assert.doesNotMatch(stage, /aria-label="common.muted"/);
  });

  it("keeps manual mute visible even if a publication snapshot is stale", () => {
    const { dock, stage } = render(true, false);
    assert.match(dock, /aria-label="common.unmuteMic"/);
    assert.match(stage, /aria-label="common.muted"/);
  });
});
