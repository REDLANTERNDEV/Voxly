import assert from "node:assert/strict";
import { it } from "node:test";
import { VoicePeerOwner } from "../src/lib/voicePeerOwner.js";
import { MicrophoneOwner } from "../src/lib/microphoneOwner.js";
import type { MicrophoneInput } from "../src/lib/microphoneInput.js";

it("invalidates transport identity before close and rejects stale disposal", () => {
  const owner = new VoicePeerOwner();
  let closes = 0;
  const peer = {
    close() {
      closes++;
      assert.equal(owner.peers.has("member"), false);
    }
  } as RTCPeerConnection;
  owner.peers.set("member", peer);
  owner.generations.set("member", 1);
  assert.equal(owner.release("member", {} as RTCPeerConnection), false);
  assert.equal(owner.release("member", peer), true);
  assert.equal(owner.generations.get("member"), 2);
  owner.clear();
  assert.equal(closes, 1);
});
it("keeps microphone receiver identity separate from screen audio", () => {
  const owner = new VoicePeerOwner(),
    peer = {} as RTCPeerConnection;
  owner.noteTrack(peer, { id: "mic" } as MediaStreamTrack, "audio");
  owner.noteTrack(peer, { id: "screen" } as MediaStreamTrack, "screen");
  assert.deepEqual(owner.microphoneTrackIds(peer), ["mic"]);
  assert.deepEqual(owner.microphoneTrackIds({} as RTCPeerConnection), []);
});
it("adoption owns one active microphone and releases each graph once", () => {
  const owner = new MicrophoneOwner();
  let first = 0,
    second = 0;
  const a = {
    dispose() {
      first++;
    }
  } as MicrophoneInput;
  const b = {
    dispose() {
      second++;
    }
  } as MicrophoneInput;
  owner.adopt(a);
  owner.adopt(a);
  assert.equal(first, 0);
  owner.adopt(b);
  assert.equal(first, 1);
  assert.equal(owner.current, b);
  owner.release();
  owner.release();
  assert.equal(second, 1);
  assert.equal(owner.current, null);
});

it("measures only live receivers with a receiving direction", () => {
  const owner = new VoicePeerOwner();
  const receiver = (id: string, direction: string, readyState = "live", kind = "audio") => ({
    currentDirection: direction,
    receiver: { track: { id, kind, readyState } }
  });
  const peer = {
    getTransceivers: () => [
      receiver("mic", "sendrecv"),
      receiver("screen", "inactive"),
      receiver("ended", "recvonly", "ended"),
      receiver("video", "recvonly", "live", "video")
    ]
  } as unknown as RTCPeerConnection;
  assert.deepEqual(owner.activeAudioTrackIds(peer), ["mic"]);
});
