import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameMessagesForServer, replacePresenceUser, replacePresenceUserIfPresent, replaceServerPresenceUserIfPresent } from "../src/lib/memberIdentity.js";

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

  it("updates online identity only when the member is already present", () => {
    const online = [{ userId: "u1", nickname: "Online", role: "member" as const }];
    const renamedOnline = { userId: "u1", nickname: "Renamed", role: "member" as const };
    const renamedOffline = { userId: "u2", nickname: "Still offline", role: "member" as const };

    assert.deepEqual(replacePresenceUserIfPresent(online, renamedOnline), [renamedOnline]);
    assert.deepEqual(replacePresenceUserIfPresent(online, renamedOffline), online);
  });

  it("does not create a presence snapshot while applying a nickname update", () => {
    const renamed = { userId: "owner", nickname: "Server Owner", role: "owner" as const };
    const withoutSnapshot = {};
    const withSnapshot = { server: [{ userId: "owner", nickname: "Old", role: "owner" as const }] };

    assert.equal(replaceServerPresenceUserIfPresent(withoutSnapshot, "server", renamed), withoutSnapshot);
    assert.deepEqual(replaceServerPresenceUserIfPresent(withSnapshot, "server", renamed), { server: [renamed] });
  });

  it("renames loaded messages only in the target server", () => {
    const messages = {
      roomA: [{ id: "a", roomId: "roomA", userId: "u1", nickname: "Old", body: "A", createdAt: "now", editedAt: null, suppressedEmbedKeys: [] }],
      roomB: [{ id: "b", roomId: "roomB", userId: "u1", nickname: "Old", body: "B", createdAt: "now", editedAt: null, suppressedEmbedKeys: [] }]
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
