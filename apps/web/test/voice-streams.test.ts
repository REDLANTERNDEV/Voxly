import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mediaStreamForTrack,
  participantsForViewedRoom,
  pruneRemoteStreamsForSnapshot,
  remoteStreamKey,
  removeRemoteStream,
  upsertRemoteStream
} from "../src/lib/voiceStreams.js";

describe("voice remote stream state", () => {
  it("scopes participant fallback to the viewed active room", () => {
    const local = { userId: "local", nickname: "Local", role: "member" as const };

    assert.deepEqual(
      participantsForViewedRoom({ roomId: "empty", members: [] }, "empty", "active", local),
      []
    );
    assert.deepEqual(participantsForViewedRoom(undefined, "active", "active", local), [local]);
    assert.deepEqual(
      participantsForViewedRoom({ roomId: "active", members: [] }, "active", "active", local),
      []
    );
  });

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

  it("does not let an ended track remove its replacement stream", () => {
    const oldStream = { id: "old-audio" } as MediaStream;
    const replacementStream = { id: "replacement-audio" } as MediaStream;
    const current = upsertRemoteStream(
      upsertRemoteStream([], "u1", "audio", oldStream),
      "u1",
      "audio",
      replacementStream
    );

    assert.deepEqual(removeRemoteStream(current, "u1", "audio", oldStream), [
      { userId: "u1", kind: "audio", stream: replacementStream }
    ]);
    assert.deepEqual(removeRemoteStream(current, "u1", "audio", replacementStream), []);
  });

  it("wraps a streamless remote track in a consumable media stream", () => {
    const track = { id: "remote-track", kind: "audio" } as MediaStreamTrack;
    const createdStream = { id: "created-stream" } as MediaStream;
    const associatedStream = { id: "associated-stream" } as MediaStream;
    const createStream = (tracks: MediaStreamTrack[]) => {
      assert.deepEqual(tracks, [track]);
      return createdStream;
    };

    assert.equal(mediaStreamForTrack(track, [associatedStream], createStream), associatedStream);
    assert.equal(mediaStreamForTrack(track, [], createStream), createdStream);
  });
});
