import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampContextMenuPosition } from "../src/lib/contextMenu.js";
import { timeFormatOptions } from "../src/lib/timeFormat.js";
import { welcomeWaveBody, type ChatMessage } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import {
  aroundNickname,
  canWaveAt,
  continuesGroup,
  formatMessageClock,
  formatMessageDateTime,
  formatMessageTimestamp,
  isMessageListNearBottom,
  messageListUpdateAction,
  messageDeleteFailureCopy,
  messagePermissions,
  shouldSubmitComposer,
  wavedNotices
} from "../src/lib/messages.js";

describe("message permissions", () => {
  it("lets members edit and delete their own messages", () => {
    assert.deepEqual(messagePermissions({ currentUserId: "u1", currentUserRole: "member", messageUserId: "u1" }), {
      canEdit: true,
      canDelete: true
    });
  });

  it("lets owners delete but not edit other users messages", () => {
    assert.deepEqual(messagePermissions({ currentUserId: "owner", currentUserRole: "owner", messageUserId: "u1" }), {
      canEdit: false,
      canDelete: true
    });
  });

  it("blocks members from moderating other users messages", () => {
    assert.deepEqual(messagePermissions({ currentUserId: "u2", currentUserRole: "member", messageUserId: "u1" }), {
      canEdit: false,
      canDelete: false
    });
  });

  it("uses a clearer delete error when the browser session no longer owns the message", () => {
    const t = (key: string) => key;

    assert.equal(messageDeleteFailureCopy(403, t), "room.messageCouldNotDeleteSession");
    assert.equal(messageDeleteFailureCopy(500, t), "room.messageCouldNotDelete");
  });
});

describe("composer keyboard behavior", () => {
  it("submits only an unmodified Enter key outside composition", () => {
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false }), true);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: true, isComposing: false }), false);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: true }), false);
    assert.equal(shouldSubmitComposer({ key: "a", shiftKey: false, isComposing: false }), false);
  });

  it("keeps accepting Enter while an earlier message is still in flight", () => {
    // Regression: an in-flight send used to gate submission, so every Enter
    // pressed during the round trip was discarded instead of queued.
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false }), true);
    assert.equal(shouldSubmitComposer({ key: "Enter", shiftKey: false, isComposing: false }), true);
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
      clampContextMenuPosition({
        x: 990,
        y: 790,
        menuWidth: 160,
        menuHeight: 96,
        viewportWidth: 1000,
        viewportHeight: 800
      }),
      { x: 832, y: 696 }
    );
    assert.deepEqual(
      clampContextMenuPosition({
        x: -5,
        y: -4,
        menuWidth: 160,
        menuHeight: 96,
        viewportWidth: 1000,
        viewportHeight: 800
      }),
      { x: 8, y: 8 }
    );
  });
});

describe("edited message timestamp", () => {
  it("formats the full local edit date and time", () => {
    const value = "2026-07-14T12:34:56.000Z";
    assert.equal(
      formatMessageDateTime(value, "en"),
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium", ...timeFormatOptions("auto") }).format(
        new Date(value)
      )
    );
  });
});

describe("message timestamp", () => {
  it("applies the chosen hour cycle independently of the interface language", () => {
    const now = new Date(2026, 6, 22, 18, 30);
    const value = new Date(2026, 6, 22, 21, 5).toISOString();

    assert.match(formatMessageTimestamp(value, "en", now, "24"), /21:05/);
    assert.match(formatMessageTimestamp(value, "tr", now, "12"), /09:05/);
  });

  it("shows only the time for messages from the current local day", () => {
    const now = new Date(2026, 6, 22, 18, 30);
    const value = new Date(2026, 6, 22, 9, 5).toISOString();

    assert.equal(
      formatMessageTimestamp(value, "en", now),
      new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", ...timeFormatOptions("auto") }).format(
        new Date(value)
      )
    );
  });

  it("includes day, month, year, and time for older messages", () => {
    const now = new Date(2026, 6, 22, 18, 30);
    const value = new Date(2025, 11, 3, 9, 5).toISOString();

    assert.equal(
      formatMessageTimestamp(value, "tr", now),
      new Intl.DateTimeFormat("tr", { dateStyle: "medium", timeStyle: "short", ...timeFormatOptions("auto") }).format(
        new Date(value)
      )
    );
  });
});

describe("Welcome notices", () => {
  const notice = welcomeMessage({ id: "notice", kind: "memberJoined", userId: "deniz", body: "" });

  it("can be deleted like any message but never edited, even by the member it welcomes", () => {
    assert.deepEqual(
      messagePermissions({
        currentUserId: "deniz",
        currentUserRole: "member",
        messageUserId: "deniz",
        messageKind: "memberJoined"
      }),
      { canEdit: false, canDelete: true }
    );
  });

  it("offers a wave to everyone but the new member, once, while they are still a member", () => {
    assert.equal(canWaveAt(notice, "ece", false), true);
    assert.equal(canWaveAt(notice, "deniz", false), false);
    assert.equal(canWaveAt(notice, "ece", true), false);
    assert.equal(canWaveAt({ ...notice, authorDeleted: true }, "ece", false), false);
    assert.equal(canWaveAt({ ...notice, kind: "message" }, "ece", false), false);
  });

  it("knows which notices this member already waved at from the loaded history", () => {
    const history = [
      notice,
      welcomeMessage({ id: "wave", userId: "ece", body: welcomeWaveBody, replyToMessageId: "notice" }),
      welcomeMessage({ id: "other", userId: "owner", body: welcomeWaveBody, replyToMessageId: "elsewhere" }),
      welcomeMessage({ id: "text", userId: "ece", body: "hi", replyToMessageId: "later" })
    ];
    assert.deepEqual([...wavedNotices(history, "ece")], ["notice"]);
    assert.deepEqual([...wavedNotices(history, "owner")], ["elsewhere"]);
  });

  it("sets the nickname apart wherever each language puts it", () => {
    for (const language of ["en", "tr"] as const) {
      const sentence = translate(language, "chat.welcomeNotice", { nickname: "Deniz" });
      const { before, after } = aroundNickname((nickname) => translate(language, "chat.welcomeNotice", { nickname }));
      assert.equal(`${before}Deniz${after}`, sentence);
    }
    assert.notEqual(translate("en", "chat.welcomeWave"), translate("tr", "chat.welcomeWave"));
  });
});

function welcomeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    kind: "message",
    mentions: [],
    reactionState: { version: 0, reactions: [] },
    pinnedAt: null,
    serverId: "server",
    sequence: 1,
    id: "message",
    roomId: "general",
    userId: "user",
    nickname: "Deniz",
    authorDeleted: false,
    body: "",
    createdAt: "2026-10-26T12:00:00.000Z",
    editedAt: null,
    suppressedEmbedKeys: [],
    replyToMessageId: null,
    replyTo: null,
    ...overrides
  };
}

describe("message groups", () => {
  const at = (minutes: number, extra: Record<string, unknown> = {}) => ({
    userId: "ada",
    createdAt: new Date(2026, 9, 28, 12, minutes).toISOString(),
    ...extra
  });

  it("continues one person's lines within seven minutes", () => {
    assert.equal(continuesGroup(at(0), at(1)), true);
    assert.equal(continuesGroup(at(0), at(7)), true);
    assert.equal(continuesGroup(at(0), at(8)), false);
    assert.equal(continuesGroup(undefined, at(0)), false);
  });

  it("starts over for another author, a reply, a Welcome notice or a deleted author", () => {
    assert.equal(continuesGroup(at(0), at(1, { userId: "deniz" })), false);
    assert.equal(continuesGroup(at(0), at(1, { replyToMessageId: "m1" })), false);
    assert.equal(continuesGroup(at(0, { kind: "memberJoined" }), at(1)), false);
    assert.equal(continuesGroup(at(0), at(1, { kind: "memberJoined" })), false);
    assert.equal(continuesGroup(at(0, { authorDeleted: true }), at(1, { authorDeleted: true })), false);
  });

  it("starts over on a new local day even inside the window", () => {
    const late = { userId: "ada", createdAt: new Date(2026, 9, 28, 23, 58).toISOString() };
    const early = { userId: "ada", createdAt: new Date(2026, 9, 29, 0, 1).toISOString() };
    assert.equal(continuesGroup(late, early), false);
  });

  it("fits the gutter by dropping a 12-hour clock's AM/PM", () => {
    const value = new Date(2026, 9, 28, 22, 58).toISOString();
    assert.equal(formatMessageClock(value, "en", "24"), "22:58");
    assert.equal(formatMessageClock(value, "en", "12"), "10:58");
  });
});
