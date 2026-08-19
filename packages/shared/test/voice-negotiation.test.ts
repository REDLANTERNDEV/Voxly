import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldIgnoreIncomingOffer, shouldInitiatePeerConnection } from "../src/index.js";

const userIds = ["0f2a", "6d11", "a3c9", "a3ca", "f000"];

describe("offer initiation", () => {
  it("elects exactly one offerer for every pair", () => {
    for (const a of userIds) {
      for (const b of userIds.filter((other) => other !== a)) {
        assert.equal(
          Number(shouldInitiatePeerConnection(a, b)) + Number(shouldInitiatePeerConnection(b, a)),
          1,
          `${a} and ${b} must agree on exactly one offerer`
        );
      }
    }
  });

  it("decides the same way whichever side asks first", () => {
    assert.equal(shouldInitiatePeerConnection("a3c9", "a3ca"), true);
    assert.equal(shouldInitiatePeerConnection("a3ca", "a3c9"), false);
  });

  it("never connects a member to itself", () => {
    assert.equal(shouldInitiatePeerConnection("a3c9", "a3c9"), false);
  });
});

describe("simultaneous offers", () => {
  it("keeps the polite peer's own offer out of the way", () => {
    assert.equal(shouldIgnoreIncomingOffer("f000", "0f2a", "stable", true), false);
    assert.equal(shouldIgnoreIncomingOffer("f000", "0f2a", "have-local-offer", false), false);
  });

  it("makes the impolite peer discard the colliding offer", () => {
    assert.equal(shouldIgnoreIncomingOffer("0f2a", "f000", "stable", true), true);
    assert.equal(shouldIgnoreIncomingOffer("0f2a", "f000", "have-local-offer", false), true);
  });

  it("accepts an offer that collides with nothing, from either side", () => {
    assert.equal(shouldIgnoreIncomingOffer("0f2a", "f000", "stable", false), false);
    assert.equal(shouldIgnoreIncomingOffer("f000", "0f2a", "stable", false), false);
  });

  it("counts an offer still being built as a collision, before signaling has moved", () => {
    assert.equal(shouldIgnoreIncomingOffer("0f2a", "f000", "stable", true), true);
  });

  it("yields to the side the initiation rule did not pick", () => {
    for (const a of userIds) {
      for (const b of userIds.filter((other) => other !== a)) {
        assert.equal(
          shouldIgnoreIncomingOffer(a, b, "stable", true),
          shouldInitiatePeerConnection(a, b),
          `${a} must resolve a collision with ${b} the same way it decides who offers`
        );
      }
    }
  });
});
