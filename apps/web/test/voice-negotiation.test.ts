import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectionStatusFor, shouldOfferToJoiningMember } from "../src/lib/voiceNegotiation.js";

describe("voice negotiation ownership", () => {
  it("has existing room members offer to a newly joined member", () => {
    assert.equal(shouldOfferToJoiningMember("existing-user", "joining-user", "joining-user"), true);
  });

  it("does not let the joining member create a competing offer", () => {
    assert.equal(shouldOfferToJoiningMember("joining-user", "existing-user", "joining-user"), false);
  });

  it("does not create offers for unrelated members", () => {
    assert.equal(shouldOfferToJoiningMember("existing-user", "other-user", "joining-user"), false);
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
