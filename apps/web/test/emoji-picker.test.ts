import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { chatEmojiGroups } from "@voxly/shared";
import { moveInGrid } from "../src/lib/emojiGrid.js";
import { translate } from "../src/lib/i18n.js";

const picker = readFileSync("src/features/chat/EmojiPicker.tsx", "utf8");

describe("emoji grid keys", () => {
  it("moves a row up and down without leaving the grid", () => {
    assert.equal(moveInGrid(3, "ArrowDown", 8, 20), 11);
    assert.equal(moveInGrid(15, "ArrowDown", 8, 20), 19);
    assert.equal(moveInGrid(3, "ArrowUp", 8, 20), 0);
    assert.equal(moveInGrid(11, "ArrowUp", 8, 20), 3);
  });

  it("wraps left and right along the whole list, and jumps with Home and End", () => {
    assert.equal(moveInGrid(19, "ArrowRight", 8, 20), 0);
    assert.equal(moveInGrid(0, "ArrowLeft", 8, 20), 19);
    assert.equal(moveInGrid(7, "Home", 8, 20), 0);
    assert.equal(moveInGrid(7, "End", 8, 20), 19);
    assert.equal(moveInGrid(7, "Enter", 8, 20), null);
    assert.equal(moveInGrid(0, "ArrowDown", 8, 0), null);
  });
});

describe("emoji picker", () => {
  it("opens on what this Device used last, then every group in catalogue order", () => {
    assert.match(picker, /\.\.\.\(recentEntries\.length\s*\?\s*\[\{\s*id:\s*"recent"/);
    assert.match(picker, /\.\.\.chatEmojiGroups\.map\(\(group\)/);
    // Choosing from the picker is what fills Recently used, for the composer and reactions alike.
    assert.match(picker, /function\s+choose\(emoji:\s*string\)\s*\{\s*rememberEmoji\(emoji\);\s*onSelect\(emoji\);/);
  });

  it("gives every group tab a name and folds the groups into one list while searching", () => {
    assert.match(picker, /aria-label=\{sectionLabel\(id\)\}/);
    assert.match(picker, /aria-current=\{active === id \? "true" : undefined\}/);
    assert.match(picker, /if \(normalized\) \{\s*return \[\s*\{\s*id: "recent",\s*entries: chatEmojiCatalog\.filter/);
    for (const language of ["en", "tr"] as const) {
      for (const group of chatEmojiGroups) assert.ok(translate(language, `chat.emoji.${group}`).length > 0);
    }
  });

  it("names the groups and the preview in both languages", () => {
    const keys = [
      ...chatEmojiGroups.map((group) => `chat.emoji.${group}` as const),
      "chat.emoji.recent",
      "chat.emojiPreviewHint"
    ] as const;
    for (const key of keys) assert.notEqual(translate("en", key), translate("tr", key), key);
    // The preview shows the viewer's own language's words.
    assert.equal(translate("en", "chat.emojiPreview", { en: "fire", tr: "ateş" }), "fire");
    assert.equal(translate("tr", "chat.emojiPreview", { en: "fire", tr: "ateş" }), "ateş");
  });
});
