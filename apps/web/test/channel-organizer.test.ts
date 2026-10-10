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
    assert.match(organizer, /onCreateCategory\(\s*name\s*\)/);
    assert.match(organizer, /onCreateRoom\(\s*name,\s+editorRoomKind,\s+editor\.categoryId\s*\)/);
    assert.equal((organizer.match(/<PlusIcon\s+\/>\s*/g) ?? []).length, 1, "the organizer has a single plus button");
    assert.match(organizer, /openEditor\(\s*"choose",\s+null,\s+event\.currentTarget\s*\)/);
    assert.match(organizer, /organizer\.chooseCategory/);
    assert.match(organizer, /organizer\.chooseChannel/);
    assert.match(organizer, /openEditor\(\s*"room",\s+category\.id,\s+null\s*\)/);
    assert.match(
      organizer,
      /openEditor\(\s*"room",\s+null,\s+null\s*\)/,
      "the blank rail action creates an uncategorized room"
    );
    assert.match(rail, /<aside\s+className="rail"\s+onContextMenu=/);
  });

  it("uses one fullscreen dialog for category names and channel type plus name", () => {
    assert.match(organizer, /className="channel-organizer-modal"/);
    assert.match(organizer, /className="channel-organizer-editor"\s+role="dialog"\s+aria-modal="true"/);
    assert.match(organizer, /<select\s+className="input"\s+value=\{\s*editorRoomKind\s*\}\s*/);
    assert.match(organizer, /<option\s+value="text">\s*\{\s*t\(\s*"channel\.typeText"\s*\)\s*\}\s*<\/option>\s*/);
    assert.match(organizer, /<option\s+value="voice">\s*\{\s*t\(\s*"channel\.typeVoice"\s*\)\s*\}\s*<\/option>\s*/);
    assert.match(organizer, /name="organizerName"\s+value=\{\s*editorName\s*\}\s*/);
    assert.match(organizer, /organizer\.back/);
    const closeEditor = organizer.match(/function\s+closeEditor\(\s*\)\s+\{\s*[\s\S]*?\n\s+}/)?.[0] ?? "";
    assert.doesNotMatch(closeEditor, /onCreate|onRename|onDelete|persist/);
  });

  it("retains empty categories and supports mixed room kinds in each group", () => {
    assert.match(organizer, /channelGroups\(\s*categories,\s+rooms,\s+uncategorizedPosition\s*\)/);
    assert.match(organizer, /!isCollapsed\s+\?\s+\(?\s*<div\s+className="channel-category-rooms"/);
    assert.match(
      organizer,
      /group\.rooms\.length\s+===\s+0\s+\?\s+\(?\s*<div[\s\S]*?className=\{\s*`channel-category-empty\s+\$\{\s*category\s+\?\s+""\s+:\s+"channel-uncategorized-empty"\s*\}\s*`\s*\}\s*/
    );
    assert.match(rail, /rooms=\{\s*\[\.\.\.props\.rooms\.text,\s+\.\.\.props\.rooms\.voice\]\s*\}\s*/);
  });

  it("keeps Uncategorized unlabeled while preserving its group drop target", () => {
    assert.match(organizer, /const\s+isCollapsed\s+=\s+category\s+\?\s+collapsed\.has\(\s*collapseId\s*\)\s+:\s+false/);
    assert.match(
      organizer,
      /className=\{\s*`rail-section-head\s+channel-category-head\s+\$\{\s*category\s+\?\s+""\s+:\s+"channel-uncategorized-head"\s*\}\s*/
    );
    assert.match(organizer, /data-drop-group=\{\s*id\s*\}\s*/);
    assert.doesNotMatch(organizer, /channel-uncategorized-toggle/);
    assert.doesNotMatch(organizer, /<GripIcon\s+\/>\s*/, "the owner rail has no visible drag grip");
    assert.match(styles, /\.channel-uncategorized-empty\s*\{\s*[^}]*min-height:\s+20px;/);
    assert.match(styles, /\.channel-organizer\.is-dragging\s+\.channel-uncategorized-empty\s*\{\s*[^}]*border-color:/);
    assert.match(
      organizer,
      /categoryDropTarget\.categoryId\s+===\s+\(\s*category\?\.id\s+\?\?\s+null\s*\)/,
      "the uncategorized category target is compared as null in its preview state"
    );
  });

  it("targets full category groups and previews the exact before or after placement", () => {
    assert.match(
      organizer,
      /type\s+DropState\s+=\s+(?:\|\s*)?\{\s+kind:\s+"category";\s+categoryId:\s+string\s+\|\s+null;\s+after:\s+boolean\s+\}\s*/
    );
    assert.match(organizer, /node\.closest<HTMLElement>\s*\(\s*"\[data-category-id\]"\s*\)/);
    assert.match(organizer, /after:\s+y\s+>\s*=\s+rect\.top\s+\+\s+rect\.height\s+\/\s+2/);
    assert.match(organizer, /moveGroup\(\s*localGroups,\s+sourceId,\s+target\.categoryId,\s+target\.after\s*\)/);
    assert.match(
      styles,
      /\.channel-category\.is-category-drop-before::before,[\s\S]*?\.channel-category\.is-category-drop-after::after/
    );
  });

  it("keeps the category chevron in its own fixed-width slot without rotation animation", () => {
    assert.match(organizer, /<ChevronIcon\s+direction=\{\s*isCollapsed\s+\?\s+"right"\s+:\s+"down"\s*\}\s+\/>\s*/);
    assert.doesNotMatch(organizer, /⌄/);
    assert.match(styles, /\.channel-category-toggle\s*\{\s*[^}]*gap:\s+9px;/);
    assert.match(styles, /\.channel-category-chevron\s*\{\s*[^}]*flex:\s+0\s+0\s+13px;[^}]*width:\s+13px;/);
    assert.doesNotMatch(styles, /\.channel-category-chevron\.is-collapsed/);
  });

  it("drags the full owner channel row and category header without stealing normal clicks", () => {
    assert.match(rail, /"data-drag-kind":\s+canManageServer\s+\?\s+"room"\s+:\s+undefined/);
    assert.match(organizer, /data-drag-kind=\{\s*canManage\s+\?\s+"category"\s+:\s+undefined\s*\}\s*/);
    const pointerDown = organizer.match(/function\s+onPointerDown\(\s*event:[\s\S]*?\n\s+}/)?.[0] ?? "";
    assert.doesNotMatch(
      pointerDown,
      /event\.preventDefault\(\s*\)/,
      "normal pointer presses keep their click behavior"
    );
    assert.match(organizer, /event\.currentTarget\.setPointerCapture\(\s*event\.pointerId\s*\)/);
    assert.match(organizer, /suppressClickRef\.current\s+=\s+true/);
    assert.match(organizer, /event\.preventDefault\(\s*\)/);
    assert.match(organizer, /targetAt\(\s*event\.clientX,\s+event\.clientY,\s+candidate\.kind\s*\)/);
    assert.match(organizer, /closest<HTMLElement>\s*\(\s*"\.rail"\s*\)/);
    assert.match(organizer, /candidate\.pointerType\s+===\s+"touch"/);
    assert.match(organizer, /},\s+320\s*\)/, "touch drag starts after a hold while early movement can scroll the rail");
    assert.match(organizer, /preventScrollDuringTouchDrag/);
    assert.match(
      organizer,
      /persist\(\s*moveGroupBy\(\s*localGroups,\s+null,\s+event\.key\s+===\s+"ArrowUp"\s+\?\s+-1\s+:\s+1\s*\)\s*\)/,
      "Uncategorized stays keyboard reorderable without a visible handle"
    );
    assert.doesNotMatch(organizer, /GripIcon|channel-drag-handle/);
    assert.doesNotMatch(rail, /has-drag-handle|dragHandle/);
    assert.doesNotMatch(styles, /channel-drag-handle|has-drag-handle/);
    assert.match(
      styles,
      /\.voice-channel-users\s*\{\s*[^}]*padding-left:\s+28px;/,
      "voice members keep their normal-user alignment when owners drag the row"
    );
    assert.match(styles, /\.channel-row\[data-drag-kind="room"\]\s*\{\s*[^}]*touch-action:\s+pan-y;/);
    assert.match(styles, /\.channel-sort-item\.is-drop-before::before,[\s\S]*?background:\s+var\(\s*--accent\s*\)/);
    assert.match(styles, /\.channel-organizer-modal\s*\{\s*[^}]*position:\s+fixed;/);
    assert.match(styles, /\.channel-organizer-editor\s*\{\s*[^}]*width:\s+min\(\s*480px,\s+100%\s*\)/);
  });

  it("keeps keyboard move controls and restores the previous layout after a failed save", () => {
    assert.match(rail, /actions\.moveTo\(\s*categoryId\s*\)/);
    assert.match(rail, /actions\.moveUp\(\s*\)/);
    assert.match(rail, /actions\.moveDown\(\s*\)/);
    assert.match(organizer, /moveGroupBy\(\s*localGroups,\s+category\.id,\s+-1\s*\)/);
    assert.match(organizer, /moveGroupBy\(\s*localGroups,\s+category\.id,\s+1\s*\)/);
    assert.match(organizer, /category\?\.id\s+\?\?\s+"__uncategorized__"/);
    assert.match(organizer, /catch\s+\{\s*setLocalGroups\(\s*groups\s*\);\s*setLayoutError\(\s*true\s*\);/);
  });

  it("stores collapse preferences by server and keeps the existing mobile drawer geometry", () => {
    assert.match(organizer, /voxly:collapsed-categories:v1:/);
    assert.match(organizer, /localStorage\.setItem\(\s*`\$\{\s*collapsedStoragePrefix\s*\}\s*\$\{\s*serverId\s*\}\s*`/);
    const narrow = mediaBlock("(max-width: 900px)", ".app-shell.drawer-channels .rail");
    assert.match(narrow, /max-width:\s+min\(\s*84vw,\s+330px\s*\)/);
    assert.match(narrow, /width:\s+320px/);
    assert.match(styles, /@media\s+\(\s*max-width:\s+560px\s*\)/);
  });

  it("provides the organizer copy in English and Turkish", () => {
    for (const key of [
      "category.create",
      "category.deleteCopy",
      "category.rename",
      "channel.moveTo",
      "channel.layoutFailed",
      "organizer.createTitle",
      "organizer.chooseChannel"
    ]) {
      assert.equal(translations.match(new RegExp(`"${key}"`, "g"))?.length, 2, `${key} has both languages`);
    }
  });
});
