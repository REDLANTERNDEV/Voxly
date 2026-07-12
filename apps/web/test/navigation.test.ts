import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstServerRoomPath, getOwnerClaimTokenFromHash, parsePathRoute, resolveInitialRoute } from "../src/lib/navigation.js";

describe("frontend navigation", () => {
  it("routes authenticated users to text chat by default", () => {
    assert.equal(resolveInitialRoute({ isAuthenticated: true, inviteToken: null }), "/app/server/the-basement/text/general");
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

  it("keeps server identity in new routes and maps legacy room links to the default server", () => {
    assert.deepEqual(parsePathRoute("/app/server/weekend/text/raids"), {
      name: "text",
      serverId: "weekend",
      roomId: "raids"
    });
    assert.deepEqual(parsePathRoute("/app/voice/lobby"), {
      name: "voice",
      serverId: "the-basement",
      roomId: "lobby"
    });
  });

  it("selects a text-first destination after an access claim", () => {
    const voice = { id: "voice", serverId: "s1", name: "Voice", kind: "voice" as const, position: 1 };
    const text = { id: "text", serverId: "s1", name: "Text", kind: "text" as const, position: 2 };

    assert.equal(firstServerRoomPath("s1", [voice, text]), "/app/server/s1/text/text");
    assert.equal(firstServerRoomPath("s1", [voice]), "/app/server/s1/voice/voice");
    assert.equal(firstServerRoomPath("s1", []), "/");
  });
});
