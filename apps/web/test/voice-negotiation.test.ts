import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionStatusFor, shouldInitiatePeerConnection } from "../src/lib/voiceNegotiation.js";
import * as voiceNegotiation from "../src/lib/voiceNegotiation.js";

describe("voice negotiation ownership", () => {
  it("elects one stable offerer when membership is learned from a snapshot", () => {
    assert.equal(shouldInitiatePeerConnection("a-user", "b-user"), true);
    assert.equal(shouldInitiatePeerConnection("b-user", "a-user"), false);
  });

  it("never creates a connection to the current user", () => {
    assert.equal(shouldInitiatePeerConnection("same-user", "same-user"), false);
  });

  it("removes peers that disappeared from the active voice snapshot before they rejoin", () => {
    const staleVoicePeerUserIds = (voiceNegotiation as Record<string, unknown>).staleVoicePeerUserIds;

    assert.equal(typeof staleVoicePeerUserIds, "function");
    assert.deepEqual((staleVoicePeerUserIds as (
      peerUserIds: Iterable<string>,
      activeMemberUserIds: Iterable<string>
    ) => string[])(["active-user", "left-user"], ["active-user", "new-user"]), ["left-user"]);
  });

  it("treats an in-progress local offer as glare even while signaling is stable", () => {
    const shouldIgnoreIncomingOffer = (voiceNegotiation as Record<string, unknown>).shouldIgnoreIncomingOffer;

    assert.equal(typeof shouldIgnoreIncomingOffer, "function");
    const decide = shouldIgnoreIncomingOffer as (
      currentUserId: string,
      peerUserId: string,
      signalingState: RTCSignalingState,
      makingOffer: boolean
    ) => boolean;
    assert.equal(decide("a-user", "b-user", "stable", true), true);
    assert.equal(decide("b-user", "a-user", "stable", true), false);
    assert.equal(decide("a-user", "b-user", "stable", false), false);
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
