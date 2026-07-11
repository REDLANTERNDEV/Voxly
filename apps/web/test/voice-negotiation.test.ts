import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionStatusFor, shouldInitiatePeerConnection } from "../src/lib/voiceNegotiation.js";

describe("voice negotiation ownership", () => {
  it("elects one stable offerer when membership is learned from a snapshot", () => {
    assert.equal(shouldInitiatePeerConnection("a-user", "b-user"), true);
    assert.equal(shouldInitiatePeerConnection("b-user", "a-user"), false);
  });

  it("never creates a connection to the current user", () => {
    assert.equal(shouldInitiatePeerConnection("same-user", "same-user"), false);
  });
});

describe("voice connection status", () => {
  it("keeps a selected visual source in a connecting state until its track arrives", () => {
    assert.equal(connectionStatusFor("connecting", false), "connecting");
  });

  it("offers a retryable state when ICE or peer connection fails", () => {
    assert.equal(connectionStatusFor("failed", false), "failed");
  });

  it("marks a source ready only after its media stream arrives", () => {
    assert.equal(connectionStatusFor("connected", true), "ready");
  });
});
