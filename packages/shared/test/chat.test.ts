import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatEmojiCatalog,
  chatEmojiGroups,
  chatEmojiSet,
  validMentionRanges,
  rewriteMentionLabels,
  type MessageMention
} from "../src/index.js";

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

it("canonicalizes legacy labels to nicknames and rebases following UTF-16 ranges", () => {
  const legacy = "@Ahmet · #ABC123";
  const body = `😀 ${legacy} and @here!`;
  const mentions: MessageMention[] = [
    {
      id: "person-occurrence",
      kind: "person",
      userId: "person",
      start: 3,
      end: 3 + legacy.length,
      nickname: "Deniz Uzun",
      mentionCode: "ABC123",
      authorDeleted: false,
      recipientIds: ["person"]
    },
    {
      id: "here-occurrence",
      kind: "here",
      start: body.indexOf("@here"),
      end: body.indexOf("@here") + 5,
      nickname: "",
      mentionCode: "",
      authorDeleted: false,
      recipientIds: ["person"]
    }
  ];
  const result = rewriteMentionLabels(body, mentions);
  assert.equal(result.body, "😀 @Deniz Uzun and @here!");
  assert.equal(result.body.slice(result.mentions[1].start, result.mentions[1].end), "@here");
  assert.equal(result.mentions[0].id, mentions[0].id);
  assert.deepEqual(rewriteMentionLabels(result.body, result.mentions), result);
});

// Built at run time: the `v` flag is newer than the ES2022 the package targets.
const rgiEmoji = new RegExp("^\\p{RGI_Emoji}$", "v");

describe("emoji catalogue", () => {
  it("lists every glyph once, in a known group, with words in both languages", () => {
    assert.equal(chatEmojiSet.size, chatEmojiCatalog.length);
    for (const [emoji, group, en, tr] of chatEmojiCatalog) {
      assert.ok(chatEmojiGroups.includes(group), `${emoji} group`);
      assert.ok(en.trim().length > 0 && tr.trim().length > 0, `${emoji} words`);
    }
    assert.ok(chatEmojiCatalog.length > 900);
    assert.deepEqual(
      chatEmojiGroups.filter((group) => !chatEmojiCatalog.some((entry) => entry[1] === group)),
      []
    );
  });

  it("holds only fully-qualified RGI emoji, and no flags or skin tones", () => {
    for (const [emoji] of chatEmojiCatalog) {
      assert.match(emoji, rgiEmoji, emoji);
      // Windows draws a regional-indicator flag as two letters.
      assert.doesNotMatch(emoji, /\p{Regional_Indicator}/u, emoji);
      assert.doesNotMatch(emoji, /\p{Emoji_Modifier}/u, emoji);
    }
  });

  it("keeps every emoji the original catalogue admitted, so existing reactions stay valid", () => {
    const original =
      "😀😃😄😁😆😂🤣😊😉😍🥰😘😎🤔🤨😐🙄😏😴😭😢😡😱🤯🥳🤩🥺🤗🤭🫡👍👎👏🙌🙏👋🤝💪👌✌️🤞🤘" +
      "❤️🧡💛💚💙💜🖤🤍💔💯✅❌❓🎉🎊🎮🏆⚽🎵🎸🔥✨⭐🌈☀️🌙🐱🐶🌸☕🍕🍔🍿🎂🍻🚀💡💻📌🎁👀💤";
    const glyphs = original.match(new RegExp("\\p{RGI_Emoji}", "gv")) ?? [];
    assert.equal(glyphs.length, 84);
    for (const emoji of glyphs) assert.ok(chatEmojiSet.has(emoji), emoji);
  });
});
