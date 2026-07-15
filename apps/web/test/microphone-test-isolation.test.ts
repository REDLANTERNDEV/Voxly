import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimMicrophoneTestDeafen,
  shouldRestoreMicrophoneTestDeafen
} from "../src/lib/microphoneTestIsolation.js";

describe("microphone test voice isolation", () => {
  it("auto-deafens an undeafened voice session and restores only that session", () => {
    const claim = claimMicrophoneTestDeafen("room-a", false);

    assert.equal(claim.shouldDeafen, true);
    assert.deepEqual(claim.lease, { roomId: "room-a", restoreDeafened: false });
    assert.equal(shouldRestoreMicrophoneTestDeafen(claim.lease, "room-a"), true);
    assert.equal(shouldRestoreMicrophoneTestDeafen(claim.lease, "room-b"), false);
    assert.equal(shouldRestoreMicrophoneTestDeafen(claim.lease, null), false);
  });

  it("preserves a session that was already deafened", () => {
    const claim = claimMicrophoneTestDeafen("room-a", true);

    assert.equal(claim.shouldDeafen, false);
    assert.equal(shouldRestoreMicrophoneTestDeafen(claim.lease, "room-a"), false);
  });
});
