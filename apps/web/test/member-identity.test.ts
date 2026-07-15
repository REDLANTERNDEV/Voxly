import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameMessagesForServer, replacePresenceUser } from "../src/lib/memberIdentity.js";

describe("server member identity updates", () => {
  it("replaces one presence user without duplicating it", () => {
    assert.deepEqual(
      replacePresenceUser(
        [{ userId: "u1", nickname: "Old", role: "member" }],
        { userId: "u1", nickname: "New", role: "member" }
      ),
      [{ userId: "u1", nickname: "New", role: "member" }]
    );
  });

  it("renames loaded messages only in the target server", () => {
    const messages = {
      roomA: [{ id: "a", roomId: "roomA", userId: "u1", nickname: "Old", body: "A", createdAt: "now", editedAt: null }],
      roomB: [{ id: "b", roomId: "roomB", userId: "u1", nickname: "Old", body: "B", createdAt: "now", editedAt: null }]
    };
    const renamed = renameMessagesForServer(messages, { roomA: "server-a", roomB: "server-b" }, "server-a", {
      userId: "u1",
      nickname: "New",
      role: "member"
    });

    assert.equal(renamed.roomA[0].nickname, "New");
    assert.equal(renamed.roomB[0].nickname, "Old");
  });
});
