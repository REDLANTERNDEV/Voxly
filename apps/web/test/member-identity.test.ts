import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anonymizeMessagesForServer,renameMessagesForServer, replacePresenceUser, replacePresenceUserIfPresent, replaceServerPresenceUserIfPresent } from "../src/lib/memberIdentity.js";

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
      roomA: [{ id: "a", roomId: "roomA", userId: "u1", nickname: "Old", authorDeleted: false, body: "A", createdAt: "now", editedAt: null, suppressedEmbedKeys: [], replyToMessageId: null, replyTo: null }],
      roomB: [{ id: "b", roomId: "roomB", userId: "u1", nickname: "Old", authorDeleted: false, body: "B", createdAt: "now", editedAt: null, suppressedEmbedKeys: [], replyToMessageId: null, replyTo: null }]
    };
    const renamed = renameMessagesForServer(messages, { roomA: "server-a", roomB: "server-b" }, "server-a", {
      userId: "u1",
      nickname: "New",
      role: "member"
    });

    assert.equal(renamed.roomA[0].nickname, "New");
    assert.equal(renamed.roomB[0].nickname, "Old");
  });

  it("anonymizes loaded messages and reply authors only in the affected server", () => {
    const messages = {
      roomA: [{ id: "a", roomId: "roomA", userId: "u1", nickname: "Old", authorDeleted: false, body: "A", createdAt: "now", editedAt: null, suppressedEmbedKeys: [], replyToMessageId: "b", replyTo: { messageId: "b", userId: "u1", nickname: "Old", authorDeleted: false, body: "B" } }],
      roomB: [{ id: "b", roomId: "roomB", userId: "u1", nickname: "Old", authorDeleted: false, body: "B", createdAt: "now", editedAt: null, suppressedEmbedKeys: [], replyToMessageId: null, replyTo: null }]
    };

    const anonymized = anonymizeMessagesForServer(messages, { roomA: "server-a", roomB: "server-b" }, "server-a", "u1");

    assert.deepEqual({ nickname: anonymized.roomA[0].nickname, deleted: anonymized.roomA[0].authorDeleted }, { nickname: "", deleted: true });
    assert.deepEqual({ nickname: anonymized.roomA[0].replyTo?.nickname, deleted: anonymized.roomA[0].replyTo?.authorDeleted }, { nickname: "", deleted: true });
    assert.equal(anonymized.roomB[0].authorDeleted, false);
  });
});
