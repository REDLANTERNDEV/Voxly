import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validMentionRanges, rewriteMentionLabels, type MessageMention } from "../src/index.js";

describe("Mention wire rules", () => {
  it("uses UTF-16 ranges after emoji and refuses overlap or out-of-body targets", () => {
    const body = "😀 @here @everyone";
    assert.equal(
      validMentionRanges(body, [
        { kind: "here", start: 3, end: 8 },
        { kind: "everyone", start: 9, end: 18 }
      ]),
      true
    );
    assert.equal(validMentionRanges(body, [{ kind: "here", start: 2, end: 7 }]), false);
    assert.equal(validMentionRanges(body, [{ kind: "here", start: 3, end: 19 }]), false);
    assert.equal(
      validMentionRanges(body, [
        { kind: "here", start: 3, end: 8 },
        { kind: "person", userId: "person", start: 7, end: 10 }
      ]),
      false
    );
  });
  it("does not interpret arbitrary text or a mislabeled collective target as a Mention", () => {
    assert.equal(validMentionRanges("ordinary text", []), true);
    assert.equal(validMentionRanges("ordinary text", [{ kind: "person", userId: "person", start: 0, end: 8 }]), false);
    assert.equal(validMentionRanges("@here", [{ kind: "everyone", start: 0, end: 5 }]), false);
  });
  it("removes generated personal names at the tombstone boundary while retaining authored text and identity", () => {
    const body = "hello @Deniz · #ABC123!";
    const mention: MessageMention = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "person",
      userId: "person",
      start: 6,
      end: body.length - 1,
      nickname: "",
      mentionCode: "ABC123",
      authorDeleted: true,
      recipientIds: ["person"]
    };
    const result = rewriteMentionLabels(body, [mention]);
    assert.equal(result.body, "hello @#ABC123!");
    assert.equal(result.mentions[0].kind === "person" && result.mentions[0].userId, "person");
    assert.equal(result.body.slice(result.mentions[0].start, result.mentions[0].end), "@#ABC123");
  });
});
