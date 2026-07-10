import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOwnerClaimTokenFromHash, parsePathRoute, resolveInitialRoute } from "../src/lib/navigation.js";

describe("frontend navigation", () => {
  it("routes authenticated users to text chat by default", () => {
    assert.equal(resolveInitialRoute({ isAuthenticated: true, inviteToken: null }), "/app/text/general");
  });

  it("keeps invite tokens on the invite screen for unauthenticated users", () => {
    assert.equal(resolveInitialRoute({ isAuthenticated: false, inviteToken: "VX-123" }), "/invite/VX-123");
  });

  it("routes unauthenticated users without an invite to the landing page", () => {
    assert.equal(resolveInitialRoute({ isAuthenticated: false, inviteToken: null }), "/");
  });

  it("reads owner claim tokens from URL fragments", () => {
    assert.equal(getOwnerClaimTokenFromHash("#claim=abc%20123"), "abc 123");
    assert.equal(getOwnerClaimTokenFromHash("#token=abc"), "");
  });

  it("keeps the root route on the landing page", () => {
    assert.deepEqual(parsePathRoute("/"), { name: "landing" });
    assert.deepEqual(parsePathRoute("/invite"), { name: "invite", token: "" });
    assert.deepEqual(parsePathRoute("/invite/VX-123"), { name: "invite", token: "VX-123" });
  });
});
