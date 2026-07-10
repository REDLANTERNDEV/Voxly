import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldOfferToJoiningMember } from "../src/lib/voiceNegotiation.js";

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
