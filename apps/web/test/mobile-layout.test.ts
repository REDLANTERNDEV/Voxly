import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

/**
 * The narrow layout, held to the shape it was fixed into.
 *
 * A phone gets a different interface out of the same markup, so the rules that
 * make it usable live entirely in media queries — which no amount of reading
 * the components will show. These assertions are structural on purpose: they
 * cannot prove the result looks right, only that the handful of declarations
 * the layout leans on are still there to be looked at.
 */

const styles = readFileSync("src/styles.css", "utf8");

/**
 * The body of one top-level `@media` block. A condition the file uses more than
 * once is disambiguated by a string the wanted block contains.
 */
function mediaBlock(condition: string, contains?: string) {
  const opening = `@media ${condition} {`;
  for (let start = styles.indexOf(opening); start !== -1; start = styles.indexOf(opening, start + 1)) {
    let depth = 0;
    for (let index = start; index < styles.length; index += 1) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] !== "}") continue;
      depth -= 1;
      if (depth > 0) continue;
      const block = styles.slice(start, index + 1);
      if (!contains || block.includes(contains)) return block;
      break;
    }
  }
  throw new Error(`missing @media ${condition}${contains ? ` containing ${contains}` : ""}`);
}

/** One declaration out of the concatenated application source. */
function declaration(name: string, boundary: string) {
  const source = readAppSource().match(
    new RegExp(`function ${name}\\b[\\s\\S]*?\\n}\\n\\n(?:function|interface) ${boundary}\\b`)
  );
  assert.notEqual(source, null, `missing ${name} up to ${boundary}`);
  return source?.[0] ?? "";
}

const narrow = mediaBlock("(max-width: 900px)", ".room-header");
const phone = mediaBlock("(max-width: 560px)");

describe("narrow layout", () => {
  it("gives the room the growing row once the room header is not drawn", () => {
    // Three tracks for header, room and composer, with only two of the three
    // present, hands the composer the one that grows.
    assert.match(narrow, /\.room-header\s+\{\s*display:\s+none;/);
    assert.match(narrow, /\.main-panel\s+\{[^}]*grid-template-rows:\s+minmax\(0,\s+1fr\)\s+auto;/);
  });

  it("keeps the composer on one row with a marked send control", () => {
    assert.match(narrow, /\.composer\s+form\s+\{[^}]*grid-template-columns:\s+minmax\(0,\s+1fr\)\s+auto;/);
    assert.match(narrow, /\.composer-send\s+span\s+\{\s*display:\s+none;/);
    assert.match(narrow, /\.composer\s+\.error-text:empty\s+\{\s*display:\s+none;/);
    // The heading goes off the screen rather than out of the document: it is
    // what names the field.
    assert.match(narrow, /\.composer-field-label\s+\{[^}]*position:\s+absolute;/);
  });

  it("names the controls whose words the narrow layout drops", () => {
    assert.match(
      declaration("TextRoomScreen", "StageSource"),
      /className="btn\s+btn-primary\s+composer-send"[^>]*aria-label=/
    );
    assert.match(
      declaration("VoiceDock", "ConnectionSignal"),
      /className="btn\s+btn-danger\s+dock-leave"[^>]*aria-label=/
    );
    assert.match(
      declaration("VoiceDock", "ConnectionSignal"),
      /className="btn\s+btn-ghost\s+account-owner-link"[^>]*label=/
    );

    assert.match(narrow, /\.mobile-topbar\s+\.icon-btn\s+span\s+\{\s*display:\s+none;/);
    assert.match(narrow, /\.dock-leave\s+span,\s*\.dock-owner\s+span\s+\{\s*display:\s+none;/);
  });

  it("moves mobile status into the drawer and reserves only active call controls", () => {
    const visual = readFileSync("src/visual-refresh.css", "utf8");
    assert.match(visual, /--dock:\s+76px;\s+--dock-quiet:\s+0px;/);
    assert.match(
      visual,
      /\.voice-dock:not\(\.drawer-voice-status\):has\(>\s+\.dock-controls:empty\)\s+\{\s+display:\s+none;\s+\}/
    );
    assert.match(visual, /\.mobile-drawer-status\s+\{\s+display:\s+grid;/);
    assert.match(visual, /\.drawer-download\s+\{[^}]*min-height:\s+44px;/);
    assert.match(readAppSource(), /surface="drawer"/);
  });

  it("keeps the dock controls at the documented mobile hit area", () => {
    assert.match(narrow, /\.dock-controls\s+\.control-icon\s+\{[^}]*height:\s+40px;[^}]*width:\s+40px;/);
  });

  it("scrolls the owner sections rather than sharing the width between them", () => {
    assert.match(narrow, /\.dash-nav\s+\{[^}]*overflow-x:\s+auto;/);
    assert.match(narrow, /\.dash-nav-item\s+\{[^}]*white-space:\s+nowrap;/);
    assert.doesNotMatch(narrow, /\.dash-nav\s+\{[^}]*grid-auto-columns/);
  });

  it("collapses the invite ledger's wider split, which outranks the plain one", () => {
    assert.match(narrow, /\.dash-split\.is-invites,[\s\S]{0,200}?grid-template-columns:\s+minmax\(0,\s+1fr\);/);
  });

  it("folds an owner table row into a card instead of a stack of full-width blocks", () => {
    assert.match(narrow, /\.dash-table-row\s+\{[^}]*grid-template-columns:\s+minmax\(0,\s+1fr\)\s+auto;/);
    assert.match(narrow, /\.dash-table-row\s+>\s+\.dash-cell\.is-actions\s+\{[^}]*grid-row:\s+1;/);
    assert.match(narrow, /\.dash-table-row\s+>\s+\.dash-cell:nth-child\(3\)\s+\{[^}]*justify-items:\s+end;/);
  });
});

describe("phone layout", () => {
  it("keeps the account chip, which is the only way to sign out", () => {
    assert.match(declaration("VoiceDock", "ConnectionSignal"), /common\.logout/);
    assert.doesNotMatch(phone, /\.dock-self\s+\{\s*display:\s+none;/);
  });
});

describe("touch affordances", () => {
  it("gives sidebar menu triggers a target a finger can hit", () => {
    const coarse = mediaBlock("(pointer: coarse)", ".message-reply-trigger,");

    assert.match(coarse, /\.sidebar-menu-trigger\s+\{\s*height:\s+36px;\s*width:\s+36px;/);
  });
});
