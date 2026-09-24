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
  it("keeps one plus button and opens a shared category or channel flow", () => {
    assert.match(organizer, /onCreateCategory\(name\)/);
    assert.match(organizer, /onCreateRoom\(name, editorRoomKind, editor\.categoryId\)/);
    assert.equal((organizer.match(/<PlusIcon \/>/g) ?? []).length, 1, "the organizer has a single plus button");
    assert.match(organizer, /openEditor\("choose", null, event\.currentTarget\)/);
    assert.match(organizer, /organizer\.chooseCategory/);
    assert.match(organizer, /organizer\.chooseChannel/);
    assert.match(organizer, /openEditor\("room", category\.id, null\)/);
    assert.match(organizer, /openEditor\("room", null, null\)/, "the blank rail action creates an uncategorized room");
    assert.match(rail, /<aside className="rail" onContextMenu=/);
  });

  it("uses one fullscreen dialog for category names and channel type plus name", () => {
    assert.match(organizer, /className="channel-organizer-modal"/);
    assert.match(organizer, /className="channel-organizer-editor" role="dialog" aria-modal="true"/);
    assert.match(organizer, /<select className="input" value=\{editorRoomKind\}/);
    assert.match(organizer, /<option value="text">\{t\("channel\.typeText"\)\}<\/option>/);
    assert.match(organizer, /<option value="voice">\{t\("channel\.typeVoice"\)\}<\/option>/);
    assert.match(organizer, /name="organizerName" value=\{editorName\}/);
    assert.match(organizer, /organizer\.back/);
    const closeEditor = organizer.match(/function closeEditor\(\) \{[\s\S]*?\n  }/)?.[0] ?? "";
    assert.doesNotMatch(closeEditor, /onCreate|onRename|onDelete|persist/);
  });

  it("retains empty categories and supports mixed room kinds in each group", () => {
    assert.match(organizer, /channelGroups\(categories, rooms, uncategorizedPosition\)/);
    assert.match(organizer, /!isCollapsed \? <div className="channel-category-rooms"/);
    assert.match(organizer, /group\.rooms\.length === 0 \? <div className=\{`channel-category-empty \$\{category \? "" : "channel-uncategorized-empty"\}`\}/);
    assert.match(rail, /rooms=\{\[\.\.\.props\.rooms\.text, \.\.\.props\.rooms\.voice\]\}/);
  });

  it("keeps Uncategorized unlabeled while preserving its group drop target", () => {
    assert.match(organizer, /const isCollapsed = category \? collapsed\.has\(collapseId\) : false/);
    assert.match(organizer, /className=\{`rail-section-head channel-category-head \$\{category \? "" : "channel-uncategorized-head"\}/);
    assert.match(organizer, /data-drop-group=\{id\}/);
    assert.doesNotMatch(organizer, /channel-uncategorized-toggle/);
    assert.equal((organizer.match(/<GripIcon \/>/g) ?? []).length, 2, "room and category handles use the same grip icon");
    assert.match(styles, /\.channel-uncategorized-empty\s*\{[^}]*min-height: 20px;/);
    assert.match(styles, /\.channel-organizer\.is-dragging \.channel-uncategorized-empty\s*\{[^}]*border-color:/);
    assert.match(organizer, /categoryDropTarget\.categoryId === \(category\?\.id \?\? null\)/, "the uncategorized category target is compared as null in its preview state");
  });

  it("targets full category groups and previews the exact before or after placement", () => {
    assert.match(organizer, /type DropState = \{ kind: "category"; categoryId: string \| null; after: boolean \}/);
    assert.match(organizer, /node\.closest<HTMLElement>\("\[data-category-id\]"\)/);
    assert.match(organizer, /after: y >= rect\.top \+ rect\.height \/ 2/);
    assert.match(organizer, /moveGroup\(localGroups, sourceId, target\.categoryId, target\.after\)/);
    assert.match(styles, /\.channel-category\.is-category-drop-before::before,[\s\S]*?\.channel-category\.is-category-drop-after::after/);
  });

  it("keeps the category chevron in its own fixed-width slot without rotation animation", () => {
    assert.match(organizer, /<ChevronIcon direction=\{isCollapsed \? "right" : "down"\} \/>/);
    assert.doesNotMatch(organizer, /⌄/);
    assert.match(styles, /\.channel-category-toggle\s*\{[^}]*gap: 9px;/);
    assert.match(styles, /\.channel-category-chevron\s*\{[^}]*flex: 0 0 13px;[^}]*width: 13px;/);
    assert.doesNotMatch(styles, /\.channel-category-chevron\.is-collapsed/);
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
    assert.match(styles, /\.channel-organizer-modal\s*\{[^}]*position: fixed;/);
    assert.match(styles, /\.channel-organizer-editor\s*\{[^}]*width: min\(480px, 100%\)/);
    assert.match(styles, /\.channel-drag-handle \.grip-icon\s*\{[^}]*width: 12px;/);
  });

  it("keeps keyboard move controls and restores the previous layout after a failed save", () => {
    assert.match(rail, /actions\.moveTo\(categoryId\)/);
    assert.match(rail, /actions\.moveUp\(\)/);
    assert.match(rail, /actions\.moveDown\(\)/);
    assert.match(organizer, /moveGroupBy\(localGroups, category\.id, -1\)/);
    assert.match(organizer, /moveGroupBy\(localGroups, category\.id, 1\)/);
    assert.match(organizer, /category\?\.id \?\? "__uncategorized__"/);
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
    for (const key of ["category.create", "category.deleteCopy", "category.rename", "channel.moveTo", "channel.layoutFailed", "organizer.createTitle", "organizer.chooseChannel"]) {
      assert.equal(translations.match(new RegExp(`"${key}"`, "g"))?.length, 2, `${key} has both languages`);
    }
  });
});
