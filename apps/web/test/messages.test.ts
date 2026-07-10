import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageDeleteFailureCopy, messagePermissions } from "../src/lib/messages.js";

describe("message permissions", () => {
  it("lets members edit and delete their own messages", () => {
    assert.deepEqual(
      messagePermissions({ currentUserId: "u1", currentUserRole: "member", messageUserId: "u1" }),
      { canEdit: true, canDelete: true }
    );
  });

  it("lets owners delete but not edit other users messages", () => {
    assert.deepEqual(
      messagePermissions({ currentUserId: "owner", currentUserRole: "owner", messageUserId: "u1" }),
      { canEdit: false, canDelete: true }
    );
  });

  it("blocks members from moderating other users messages", () => {
    assert.deepEqual(
      messagePermissions({ currentUserId: "u2", currentUserRole: "member", messageUserId: "u1" }),
      { canEdit: false, canDelete: false }
    );
  });

  it("uses a clearer delete error when the browser session no longer owns the message", () => {
    const t = (key: string) => key;

    assert.equal(messageDeleteFailureCopy(403, t), "room.messageCouldNotDeleteSession");
    assert.equal(messageDeleteFailureCopy(500, t), "room.messageCouldNotDelete");
  });
});
