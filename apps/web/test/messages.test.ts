import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampContextMenuPosition } from "../src/lib/contextMenu.js";
import {
  formatMessageDateTime,
  formatMessageTimestamp,
  isMessageListNearBottom,
  messageListUpdateAction,
  messageDeleteFailureCopy,
  messagePermissions,
  shouldSubmitComposer
} from "../src/lib/messages.js";

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

describe("composer keyboard behavior", () => {
  it("submits only an unmodified Enter key outside composition while idle", () => {
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, isSending: false }), true);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false, isSending: false }), false);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true, isSending: false }), false);
    assert.equal(shouldSubmitComposer({ key: "a", shiftKey: false, isComposing: false, isSending: false }), false);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false, isSending: true }), false);
  });
});

describe("message list scrolling", () => {
  it("treats the final 48 pixels as near the bottom", () => {
    assert.equal(isMessageListNearBottom({ scrollHeight: 1000, scrollTop: 552, clientHeight: 400 }), true);
    assert.equal(isMessageListNearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }), false);
  });

  it("distinguishes appended messages from duplicate realtime updates and edits", () => {
    assert.equal(messageListUpdateAction(["m1"], ["m1", "m2"], true), "scroll");
    assert.equal(messageListUpdateAction(["m1"], ["m1", "m2"], false), "notify");
    assert.equal(messageListUpdateAction(["m1", "m2"], ["m1", "m2"], true), "none");
  });
});

describe("message menu position", () => {
  it("keeps the menu within the viewport margin", () => {
    assert.deepEqual(
      clampContextMenuPosition({ x: 990, y: 790, menuWidth: 160, menuHeight: 96, viewportWidth: 1000, viewportHeight: 800 }),
      { x: 832, y: 696 }
    );
    assert.deepEqual(
      clampContextMenuPosition({ x: -5, y: -4, menuWidth: 160, menuHeight: 96, viewportWidth: 1000, viewportHeight: 800 }),
      { x: 8, y: 8 }
    );
  });
});

describe("edited message timestamp", () => {
  it("formats the full local edit date and time", () => {
    const value = "2026-07-14T12:34:56.000Z";
    assert.equal(
      formatMessageDateTime(value, "en"),
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value))
    );
  });
});

describe("message timestamp", () => {
  it("shows only the time for messages from the current local day", () => {
    const now = new Date(2026, 6, 22, 18, 30);
    const value = new Date(2026, 6, 22, 9, 5).toISOString();

    assert.equal(
      formatMessageTimestamp(value, "en", now),
      new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(value))
    );
  });

  it("includes day, month, year, and time for older messages", () => {
    const now = new Date(2026, 6, 22, 18, 30);
    const value = new Date(2025, 11, 3, 9, 5).toISOString();

    assert.equal(
      formatMessageTimestamp(value, "tr", now),
      new Intl.DateTimeFormat("tr", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    );
  });
});
