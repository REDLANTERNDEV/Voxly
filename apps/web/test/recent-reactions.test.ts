import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultQuickReactions,
  quickReactions,
  readRecentEmoji,
  recentEmojiLimit,
  recentEmojiStorageKey,
  rememberEmoji
} from "../src/lib/recentReactions.js";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[recentEmojiStorageKey, initial]]);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value)
  };
}

describe("recent emoji", () => {
  it("puts the latest first and lists each emoji once", () => {
    const storage = memoryStorage();
    rememberEmoji("🔥", storage);
    rememberEmoji("🎉", storage);
    rememberEmoji("🔥", storage);
    assert.deepEqual(readRecentEmoji(storage), ["🔥", "🎉"]);
  });

  it("keeps a bounded list of catalogue glyphs only", () => {
    const storage = memoryStorage();
    rememberEmoji("not an emoji", storage);
    rememberEmoji("🇹🇷", storage);
    assert.deepEqual(readRecentEmoji(storage), []);
    const many = ["😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "😉", "😍", "🥰", "😘", "😎", "🤔", "🤨"];
    for (const emoji of [...many, ...many.map(() => "🍕"), "🦩", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔"])
      rememberEmoji(emoji, storage);
    assert.equal(readRecentEmoji(storage).length, recentEmojiLimit);
  });

  it("falls back quietly on damaged or unavailable storage", () => {
    assert.deepEqual(readRecentEmoji(memoryStorage("{not json")), []);
    assert.deepEqual(readRecentEmoji(memoryStorage(JSON.stringify({ emoji: "🔥" }))), []);
    assert.deepEqual(readRecentEmoji(memoryStorage(JSON.stringify(["🔥", 4, "🔥", "x"]))), ["🔥"]);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };
    assert.deepEqual(readRecentEmoji(throwing), []);
    assert.doesNotThrow(() => rememberEmoji("🔥", throwing));
  });

  it("tops the toolbar's three up with the defaults", () => {
    assert.deepEqual(quickReactions([]), [...defaultQuickReactions]);
    assert.deepEqual(quickReactions(["🔥"]), ["🔥", "👍", "❤️"]);
    assert.deepEqual(quickReactions(["👍", "🔥"]), ["👍", "🔥", "❤️"]);
    assert.deepEqual(quickReactions(["🔥", "🎉", "🍕", "🦩"]), ["🔥", "🎉", "🍕"]);
  });
});
