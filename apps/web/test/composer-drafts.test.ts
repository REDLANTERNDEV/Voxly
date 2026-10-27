import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatMessageReply, MessageMention } from "@voxly/shared";
import { createDraftMemory } from "../src/lib/composerDrafts.js";

const mention: MessageMention = {
  id: "m1",
  kind: "person",
  userId: "u2",
  start: 3,
  end: 9,
  nickname: "Deniz",
  mentionCode: "9E831C",
  authorDeleted: false,
  recipientIds: ["u2"]
};

const reply: ChatMessageReply = {
  kind: "message",
  messageId: "msg1",
  userId: "u2",
  nickname: "Deniz",
  authorDeleted: false,
  body: "hello",
  mentions: []
};

describe("draft memory", () => {
  it("gives a Text channel back the text, mentions and reply its member left there", () => {
    const drafts = createDraftMemory();
    drafts.write("u1", "room-a", { body: "hi @Deniz", mentions: [mention], replyTo: reply });

    assert.deepEqual(drafts.read("u1", "room-a"), { body: "hi @Deniz", mentions: [mention], replyTo: reply });
  });

  it("keeps each Text channel's Draft apart", () => {
    const drafts = createDraftMemory();
    drafts.write("u1", "room-a", { body: "first", mentions: [], replyTo: null });
    drafts.write("u1", "room-b", { body: "second", mentions: [], replyTo: null });

    assert.equal(drafts.read("u1", "room-a")?.body, "first");
    assert.equal(drafts.read("u1", "room-b")?.body, "second");
  });

  it("never hands one account's Draft to another on the same tab", () => {
    const drafts = createDraftMemory();
    drafts.write("u1", "room-a", { body: "mine", mentions: [], replyTo: null });

    assert.equal(drafts.read("u2", "room-a"), null);
  });

  it("forgets a Draft its member emptied, so a deletion stays deleted", () => {
    const drafts = createDraftMemory();
    drafts.write("u1", "room-a", { body: "oops", mentions: [], replyTo: null });
    drafts.write("u1", "room-a", { body: "", mentions: [], replyTo: null });

    assert.equal(drafts.read("u1", "room-a"), null);
  });

  it("keeps an empty composer that is still replying to someone", () => {
    const drafts = createDraftMemory();
    drafts.write("u1", "room-a", { body: "", mentions: [], replyTo: reply });

    assert.deepEqual(drafts.read("u1", "room-a"), { body: "", mentions: [], replyTo: reply });
  });
});
