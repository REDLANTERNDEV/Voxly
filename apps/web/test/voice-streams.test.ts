import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pruneRemoteStreamsForSnapshot, remoteStreamKey, upsertRemoteStream } from "../src/lib/voiceStreams.js";

describe("voice remote stream state", () => {
  it("keys remote streams by user and media kind so camera and screen do not overwrite each other", () => {
    const camera = { id: "camera-stream" } as MediaStream;
    const screen = { id: "screen-stream" } as MediaStream;

    const streams = upsertRemoteStream(
      upsertRemoteStream([], "u1", "camera", camera),
      "u1",
      "screen",
      screen
    );

    assert.equal(remoteStreamKey("u1", "camera"), "u1:camera");
    assert.deepEqual(streams, [
      { userId: "u1", kind: "camera", stream: camera },
      { userId: "u1", kind: "screen", stream: screen }
    ]);
  });

  it("prunes stale screen and camera streams when snapshot media flags turn off", () => {
    const audio = { id: "audio-stream" } as MediaStream;
    const camera = { id: "camera-stream" } as MediaStream;
    const screen = { id: "screen-stream" } as MediaStream;

    const streams = pruneRemoteStreamsForSnapshot(
      [
        { userId: "u1", kind: "audio", stream: audio },
        { userId: "u1", kind: "camera", stream: camera },
        { userId: "u1", kind: "screen", stream: screen }
      ],
      [{ userId: "u1", camera: false, screen: false }]
    );

    assert.deepEqual(streams, [{ userId: "u1", kind: "audio", stream: audio }]);
  });
});
