import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VoiceJoinAck, VoiceJoinRequest } from "@voxly/shared";
import { createInitialVoiceControls } from "../src/lib/voiceControls.js";
import { effectiveVoiceMediaState, watchMicrophoneStreamEnd } from "../src/lib/voiceMedia.js";
import { requestVoiceJoin } from "../src/lib/voiceJoin.js";
import type { VoxlySocket } from "../src/socket.js";

describe("atomic voice join", () => {
  it("reports mic-on only for an enabled live audio track", () => {
    const controls = createInitialVoiceControls();

    assert.equal(effectiveVoiceMediaState(controls, {
      mic: fakeStream("audio", { enabled: false, readyState: "live" })
    }).mic, false);
    assert.equal(effectiveVoiceMediaState(controls, {
      mic: fakeStream("audio", { enabled: true, readyState: "ended" })
    }).mic, false);
    assert.equal(effectiveVoiceMediaState(controls, {
      mic: fakeStream("audio", { enabled: true, readyState: "live" })
    }).mic, true);
  });

  it("forces mic and speaking off while deafened", () => {
    const controls = createInitialVoiceControls();
    controls.deafen.on = true;

    assert.deepEqual(effectiveVoiceMediaState(controls, {
      mic: fakeStream("audio", { enabled: true, readyState: "live" })
    }), {
      mic: false,
      camera: false,
      screen: false,
      deafened: true,
      speaking: false
    });
  });

  it("requires enabled live video tracks for camera and screen", () => {
    const controls = createInitialVoiceControls();
    controls.camera.on = true;
    controls.screenShare.on = true;

    const media = effectiveVoiceMediaState(controls, {
      camera: fakeStream("video", { enabled: true, readyState: "live" }),
      screen: fakeStream("video", { enabled: false, readyState: "live" })
    });

    assert.equal(media.camera, true);
    assert.equal(media.screen, false);
  });

  it("settles once with the server ACK and clears its timeout", async () => {
    const response: VoiceJoinAck = {
      ok: true,
      state: {
        user: { userId: "member", nickname: "Member", role: "member" },
        media: { mic: false, camera: false, screen: false, deafened: false, speaking: false }
      }
    };
    const socket = {
      emit: (_event: string, _request: VoiceJoinRequest, ack: (value: VoiceJoinAck) => void) => ack(response)
    } as unknown as VoxlySocket;

    assert.deepEqual(await requestVoiceJoin(socket, { roomId: "lobby", media: response.state.media }, 25), response);
  });

  it("returns a deterministic timeout when no ACK arrives", async () => {
    const socket = { emit: () => undefined } as unknown as VoxlySocket;
    const request: VoiceJoinRequest = {
      roomId: "lobby",
      media: { mic: false, camera: false, screen: false, deafened: false, speaking: false }
    };

    assert.deepEqual(await requestVoiceJoin(socket, request, 1), { ok: false, error: "timeout" });
  });

  it("notifies once when the final live microphone track ends", () => {
    const first = new FakeAudioTrack();
    const second = new FakeAudioTrack();
    const stream = {
      getAudioTracks: () => [first, second]
    } as unknown as MediaStream;
    let ended = 0;
    const cleanup = watchMicrophoneStreamEnd(stream, () => { ended += 1; });

    first.end();
    assert.equal(ended, 0);
    second.end();
    second.end();
    assert.equal(ended, 1);

    cleanup();
  });

  it("does not report microphone end after lifecycle cleanup", () => {
    const track = new FakeAudioTrack();
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    let ended = 0;
    const cleanup = watchMicrophoneStreamEnd(stream, () => { ended += 1; });

    cleanup();
    track.end();

    assert.equal(ended, 0);
  });

  it("immediately reports a microphone stream that is already ended", () => {
    const track = new FakeAudioTrack();
    track.end();
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    let ended = 0;

    const cleanup = watchMicrophoneStreamEnd(stream, () => { ended += 1; });

    assert.equal(ended, 1);
    cleanup();
  });
});

function fakeStream(kind: "audio" | "video", state: Pick<MediaStreamTrack, "enabled" | "readyState">): MediaStream {
  const track = { kind, ...state } as MediaStreamTrack;
  return {
    getAudioTracks: () => kind === "audio" ? [track] : [],
    getVideoTracks: () => kind === "video" ? [track] : []
  } as MediaStream;
}

class FakeAudioTrack {
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  private readonly endedListeners = new Set<() => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "ended" || typeof listener !== "function") return;
    this.endedListeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type !== "ended" || typeof listener !== "function") return;
    this.endedListeners.delete(listener as () => void);
  }

  end() {
    this.readyState = "ended";
    for (const listener of this.endedListeners) listener();
  }
}
