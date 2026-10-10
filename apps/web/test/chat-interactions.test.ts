import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxMessageReactionKinds, validMentionRanges, rewriteMentionLabels, type MessageMention } from "@voxly/shared";
import {
  editMentionRanges,
  trimMentionDraft,
  mentionCandidates,
  mergeReactionState,
  isMentioned
} from "../src/lib/chatInteractions.js";
import { rebaseMentionSelection } from "../src/lib/chatInteractions.js";
import { anonymizeMessagesForServer, renameMessagesForServer } from "../src/lib/memberIdentity.js";
import {
  reconcileMentionContent,
  reconcileMessageIdentity,
  reconcileReplyIdentity
} from "../src/lib/memberIdentity.js";
import { appendOutboxEntry, setOutboxEntryStatus } from "../src/lib/messageOutbox.js";
import { translate } from "../src/lib/i18n.js";

const label = "@Ahmet · #A7K2X9";
const mention: MessageMention = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "person",
  userId: "person",
  start: 3,
  end: 3 + label.length,
  nickname: "Ahmet",
  mentionCode: "A7K2X9",
  authorDeleted: false,
  recipientIds: ["person"]
};
const body = `hi ${label}!`;

describe("mention draft editing", () => {
  it("preserves the original occurrence and frozen recipients when matching text is inserted before it", () => {
    const here: MessageMention = { ...mention, kind: "here", start: 0, end: 5 };
    const shifted = editMentionRanges("@here ", "@@here ", [here], { start: 0, end: 0 });
    assert.deepEqual(shifted, [{ ...here, start: 1, end: 6 }]);
    const duplicated = editMentionRanges("@here ", "@here @here ", [here], { start: 0, end: 0 });
    assert.deepEqual(duplicated, [{ ...here, start: 6, end: 11 }]);
    assert.equal(shifted[0].recipientIds, here.recipientIds);
    assert.equal(editMentionRanges(body, body, [mention])[0], mention);
    assert.deepEqual(editMentionRanges("@here", "@here", [here], { start: 0, end: 5 }), []);
  });
  it("uses selected replacement ranges to invalidate only touched labels", () => {
    const first = { ...mention, start: 0, end: label.length };
    const second = { ...mention, id: "second", start: label.length + 1, end: label.length * 2 + 1 };
    const before = `${label} ${label}`;
    const after = `😀 ${label}`;
    assert.deepEqual(editMentionRanges(before, after, [first, second], { start: 0, end: label.length }), [
      { ...second, start: 3, end: 3 + label.length }
    ]);
    // Deleting matching text immediately before a label must not erase it.
    assert.deepEqual(
      editMentionRanges(`@${label}`, label, [{ ...first, start: 1, end: label.length + 1 }], { start: 0, end: 1 }),
      [first]
    );
  });
  it("rebases labels when text or a surrogate-pair emoji is inserted before them", () => {
    const shifted = editMentionRanges(body, "😀 " + body, [mention]);
    assert.equal(shifted[0].start, mention.start + 3);
    assert.equal(shifted[0].end, mention.end + 3);
    assert.equal(shifted[0].kind === "person" && shifted[0].userId, "person");
    assert.equal(mention.start, 3);
  });
  it("keeps a label when typing after it but removes metadata when its contents change", () => {
    assert.deepEqual(editMentionRanges(body, body + " more", [mention]), [mention]);
    assert.deepEqual(editMentionRanges(body, body.replace("Ahmet", "Mehmet"), [mention]), []);
    assert.deepEqual(editMentionRanges(body, "hi !", [mention]), []);
  });
  it("rebases leading/trailing whitespace before sending", () => {
    const padded = "  " + body + "\n";
    const result = trimMentionDraft(padded, [{ ...mention, start: mention.start + 2, end: mention.end + 2 }]);
    assert.equal(result.body, body);
    assert.deepEqual(result.mentions, [mention]);
    assert.equal(validMentionRanges(result.body, result.mentions), true);
  });
  it("preserves identity metadata on a failed outbox entry", () => {
    const entries = appendOutboxEntry([], {
      localId: "local",
      body,
      mentions: [mention],
      replyTo: null,
      createdAt: "now",
      status: "pending"
    });
    assert.deepEqual(setOutboxEntryStatus(entries, "local", "failed")[0].mentions, [mention]);
  });
  it("rejects overlapping, unsorted and falsely labeled collective ranges", () => {
    assert.equal(validMentionRanges(body, [mention, mention]), false);
    assert.equal(validMentionRanges("@everyone", [{ kind: "here", start: 0, end: 9 }]), false);
    assert.equal(validMentionRanges("@here", [{ kind: "here", start: 0, end: 5 }]), true);
  });
});

describe("person identity and mention presentation", () => {
  it("updates active drafts by explicit identity facts while preserving authored text and selections", () => {
    const original = { body: body + " Ahmet", mentions: [mention] };
    assert.equal(reconcileMentionContent(original, {}), original);
    const renamed = reconcileMentionContent(original, {
      person: { userId: "person", nickname: "Deniz Uzun", mentionCode: "A7K2X9", role: "member" }
    });
    assert.equal(renamed.body, "hi @Deniz Uzun · #A7K2X9! Ahmet");
    assert.equal(renamed.mentions[0].id, mention.id);
    assert.equal(renamed.mentions[0].recipientIds, mention.recipientIds);
    const selected = rebaseMentionSelection(original.mentions, renamed.mentions, {
      start: body.length,
      end: original.body.length
    });
    assert.equal(renamed.body.slice(selected.start, selected.end), " Ahmet");
    const deleted = reconcileMentionContent(renamed, { person: null });
    assert.equal(deleted.body, "hi @#A7K2X9! Ahmet");
    assert.equal(deleted.mentions[0].nickname, "");
    assert.equal(deleted.mentions[0].authorDeleted, true);
    assert.equal(
      reconcileMentionContent(deleted, { person: { userId: "person", nickname: "Stale", role: "member" } }),
      deleted
    );
  });
  it("clears deleted reply authors and canonicalizes late message snapshots without reviving names", () => {
    const reply = {
      messageId: "target",
      userId: "person",
      nickname: "Ahmet",
      authorDeleted: false,
      body,
      mentions: [mention]
    };
    const deleted = reconcileReplyIdentity(reply, { person: null });
    assert.equal(deleted.nickname, "");
    assert.equal(deleted.authorDeleted, true);
    assert.equal(deleted.body, "hi @#A7K2X9!");
    assert.equal(reconcileReplyIdentity(deleted, { person: null }), deleted);
    const message = {
      ...reply,
      id: "message",
      serverId: "server",
      roomId: "room",
      sequence: 1,
      reactionState: { version: 0, reactions: [] },
      pinnedAt: null,
      createdAt: "now",
      editedAt: null,
      suppressedEmbedKeys: [],
      replyToMessageId: "target",
      replyTo: reply
    };
    const late = reconcileMessageIdentity(message, { person: null });
    assert.equal(late.nickname, "");
    assert.equal(late.replyTo!.nickname, "");
    assert.ok(!JSON.stringify(late).includes("Ahmet"));
    assert.equal(late.id, "message");
  });
  it("searches short codes and includes offline duplicate names without promoting their presence", () => {
    const members = [
      { userId: "offline", nickname: "Ahmet", mentionCode: "BBBBBB", role: "member" as const },
      { userId: "online", nickname: "Ahmet", mentionCode: "AAAAAA", role: "member" as const },
      { userId: "bot", nickname: "Ahmet", mentionCode: "CCCCCC", role: "member" as const, isBot: true }
    ];
    assert.deepEqual(
      mentionCandidates(members, new Set(["online"]), "ahmet").map((member) => member.userId),
      ["online", "offline"]
    );
    assert.deepEqual(
      mentionCandidates(members, new Set(["online"]), "#bbbb").map((member) => member.userId),
      ["offline"]
    );
  });
  it("rewrites only generated labels and rebases subsequent mentions", () => {
    const here: MessageMention = {
      id: "00000000-0000-4000-8000-000000000002",
      kind: "here",
      start: body.length + 1,
      end: body.length + 6,
      nickname: "",
      mentionCode: "",
      authorDeleted: false,
      recipientIds: ["person"]
    };
    const result = rewriteMentionLabels(body + " @here", [{ ...mention, nickname: "Deniz Uzun" }, here]);
    assert.equal(result.body, "hi @Deniz Uzun · #A7K2X9! @here");
    assert.equal(result.body.slice(result.mentions[1].start, result.mentions[1].end), "@here");
    assert.equal(result.mentions[0].kind === "person" && result.mentions[0].userId, "person");
  });
  it("removes deleted identities from message and quote caches only in the affected Server", () => {
    const message = {
      id: "message",
      serverId: "server",
      roomId: "room",
      sequence: 1,
      userId: "author",
      nickname: "Author",
      authorDeleted: false,
      body,
      mentions: [mention],
      reactionState: { version: 0, reactions: [] },
      pinnedAt: null,
      createdAt: "now",
      editedAt: null,
      suppressedEmbedKeys: [],
      replyToMessageId: "target",
      replyTo: {
        messageId: "target",
        userId: "author",
        nickname: "Author",
        authorDeleted: false,
        body,
        mentions: [mention]
      }
    };
    const original = { room: [message], other: [{ ...message, roomId: "other", serverId: "elsewhere" }] };
    const renamed = renameMessagesForServer(original, { room: "server", other: "elsewhere" }, "server", {
      userId: "person",
      nickname: "Deniz",
      mentionCode: "A7K2X9",
      role: "member"
    });
    assert.ok(renamed.room[0].body.includes("Deniz"));
    assert.ok(renamed.room[0].replyTo!.body.includes("Deniz"));
    const deleted = anonymizeMessagesForServer(renamed, { room: "server", other: "elsewhere" }, "server", "person");
    assert.equal(deleted.room[0].mentions[0].nickname, "");
    assert.equal(deleted.room[0].mentions[0].authorDeleted, true);
    assert.ok(!deleted.room[0].body.includes("Deniz"));
    assert.ok(!deleted.room[0].replyTo!.body.includes("Deniz"));
    assert.equal(deleted.other[0].body, body);
  });
  it("highlights frozen recipients without highlighting the author's own messages", () => {
    assert.equal(isMentioned({ userId: "author", mentions: [mention] }, "person"), true);
    assert.equal(isMentioned({ userId: "person", mentions: [mention] }, "person"), false);
    assert.equal(isMentioned({ userId: "author", mentions: [mention] }, "newcomer"), false);
  });
});

describe("reaction state and localized recovery", () => {
  it("keeps the cleared snapshot when an older response arrives afterward", () => {
    const cleared = { version: 9, reactions: [] };
    assert.equal(
      mergeReactionState(cleared, { version: 8, reactions: [{ emoji: "👍", userIds: ["person"] }] }),
      cleared
    );
    assert.equal(maxMessageReactionKinds, 8);
  });
  it("provides equivalent limit and moderation controls in both languages", () => {
    for (const key of [
      "chat.reactionLimit",
      "chat.clearAllReactions",
      "chat.clearEmojiReactions",
      "chat.contextError",
      "chat.backToLatest"
    ] as const) {
      assert.notEqual(translate("en", key), translate("tr", key));
      assert.ok(translate("en", key).length > 0 && translate("tr", key).length > 0);
    }
  });
});
