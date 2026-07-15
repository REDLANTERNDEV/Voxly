import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { voiceChannelActivation } from "../src/lib/voiceChannelActivation.js";

describe("voice channel activation", () => {
  it("joins directly when the listener is disconnected", () => {
    assert.equal(voiceChannelActivation(null, "room-b"), "join");
  });

  it("asks before moving from another voice room", () => {
    assert.equal(voiceChannelActivation("room-a", "room-b"), "confirm-move");
  });

  it("opens the room already joined", () => {
    assert.equal(voiceChannelActivation("room-a", "room-a"), "open");
  });
});
