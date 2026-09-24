import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const organizer = readFileSync("src/components/shell/ChannelOrganizer.tsx", "utf8");
const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");
const translations = readFileSync("src/lib/i18n.ts", "utf8");

function mediaBlock(condition: string, contains: string) {
  const opening = `@media ${condition} {`;
  for (let start = styles.indexOf(opening); start !== -1; start = styles.indexOf(opening, start + 1)) {
    let depth = 0;
    for (let index = start; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] !== "}") continue;
      depth -= 1;
      if (depth > 0) continue;
      const block = styles.slice(start, index + 1);
      if (block.includes(contains)) return block;
      break;
    }
  }
  throw new Error(`missing @media ${condition} containing ${contains}`);
}

describe("server channel organizer", () => {
  it("creates categories independently and creates channels in the selected group", () => {
    assert.match(organizer, /onCreateCategory\(name\)/);
    assert.match(organizer, /onCreateRoom\(name, editorRoomKind, editor\.categoryId\)/);
    assert.match(organizer, /category-create-trigger/);
    assert.match(organizer, /openEditor\("room", category\?\.id \?\? null, event\.currentTarget\)/);
    assert.match(organizer, /openEditor\("room", null, null\)/, "the blank rail action creates an uncategorized room");
    assert.match(rail, /<aside className="rail" onContextMenu=/);
  });

  it("keeps channel type and name in one cancelable form", () => {
    assert.match(organizer, /<select className="input" value=\{editorRoomKind\}/);
    assert.match(organizer, /<option value="text">\{t\("channel\.typeText"\)\}<\/option>/);
    assert.match(organizer, /<option value="voice">\{t\("channel\.typeVoice"\)\}<\/option>/);
    assert.match(organizer, /name="organizerName" value=\{editorName\}/);
    assert.match(organizer, /type="button" disabled=\{editorBusy\} onClick=\{closeEditor\}/);
    const closeEditor = organizer.match(/function closeEditor\(\) \{[\s\S]*?\n  }/)?.[0] ?? "";
    assert.doesNotMatch(closeEditor, /onCreate|onRename|onDelete|persist/);
  });

  it("retains empty categories and supports mixed room kinds in each group", () => {
    assert.match(organizer, /channelGroups\(categories, rooms\)/);
    assert.match(organizer, /!isCollapsed \? <div className="channel-category-rooms"/);
    assert.match(organizer, /group\.rooms\.length === 0 \? <div className="channel-category-empty"/);
    assert.match(rail, /rooms=\{\[\.\.\.props\.rooms\.text, \.\.\.props\.rooms\.voice\]\}/);
  });

  it("uses isolated drag handles, visible targets, auto-scroll, and suppresses click actions", () => {
    assert.match(organizer, /data-drag-kind="room"/);
    assert.match(organizer, /data-drag-kind="category"/);
    assert.match(organizer, /event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
    assert.match(organizer, /event\.preventDefault\(\)/);
    assert.match(organizer, /targetAt\(event\.clientX, event\.clientY, candidate\.kind\)/);
    assert.match(organizer, /closest<HTMLElement>\("\.rail"\)/);
    assert.match(styles, /\.channel-sort-item\.is-drop-before::before,[\s\S]*?background: var\(--accent\)/);
    assert.match(styles, /\.channel-drag-handle\s*\{[^}]*touch-action: none;/);
    assert.match(styles, /\.channel-organizer-editor\s*\{[^}]*position: fixed;[^}]*width: min\(248px, calc\(100vw - 16px\)\)/);
  });

  it("keeps keyboard move controls and restores the previous layout after a failed save", () => {
    assert.match(rail, /actions\.moveTo\(categoryId\)/);
    assert.match(rail, /actions\.moveUp\(\)/);
    assert.match(rail, /actions\.moveDown\(\)/);
    assert.match(organizer, /moveCategoryBy\(localGroups, category\.id, -1\)/);
    assert.match(organizer, /moveCategoryBy\(localGroups, category\.id, 1\)/);
    assert.match(organizer, /aria-keyshortcuts=\{\["ArrowUp", "ArrowDown"\]\.join\(" "\)\}/);
    assert.match(organizer, /event\.key === "ArrowUp" \? -1 : 1/);
    assert.match(organizer, /catch \{\s*setLocalGroups\(groups\);\s*setLayoutError\(true\);/);
  });

  it("stores collapse preferences by server and keeps the existing mobile drawer geometry", () => {
    assert.match(organizer, /voxly:collapsed-categories:v1:/);
    assert.match(organizer, /localStorage\.setItem\(`\$\{collapsedStoragePrefix\}\$\{serverId\}`/);
    const narrow = mediaBlock("(max-width: 900px)", ".app-shell.drawer-channels .rail");
    assert.match(narrow, /max-width: min\(84vw, 330px\)/);
    assert.match(narrow, /width: 320px/);
    assert.match(narrow, /\.channel-drag-handle \{\s*height: 40px;\s*width: 32px;/);
    assert.match(styles, /@media \(max-width: 560px\)/);
  });

  it("provides the organizer copy in English and Turkish", () => {
    for (const key of ["category.create", "category.deleteCopy", "category.rename", "channel.moveTo", "channel.layoutFailed"]) {
      assert.equal(translations.match(new RegExp(`"${key}"`, "g"))?.length, 2, `${key} has both languages`);
    }
  });
});
