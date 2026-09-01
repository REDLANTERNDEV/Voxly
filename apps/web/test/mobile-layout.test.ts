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

const narrow = mediaBlock("(max-width: 900px)");
const phone = mediaBlock("(max-width: 560px)");

describe("narrow layout", () => {
  it("gives the room the growing row once the room header is not drawn", () => {
    // Three tracks for header, room and composer, with only two of the three
    // present, hands the composer the one that grows.
    assert.match(narrow, /\.room-header \{\s*display: none;/);
    assert.match(narrow, /\.main-panel \{[^}]*grid-template-rows: minmax\(0, 1fr\) auto;/);
  });

  it("keeps the composer on one row with a marked send control", () => {
    assert.match(narrow, /\.composer form \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(narrow, /\.composer-send span \{\s*display: none;/);
    assert.match(narrow, /\.composer \.error-text:empty \{\s*display: none;/);
    // The heading goes off the screen rather than out of the document: it is
    // what names the field.
    assert.match(narrow, /\.composer-field-label \{[^}]*position: absolute;/);
  });

  it("names the controls whose words the narrow layout drops", () => {
    assert.match(declaration("TextRoomScreen", "StageSource"), /className="btn btn-primary composer-send"[^>]*aria-label=/);
    assert.match(declaration("VoiceDock", "ConnectionSignal"), /className="btn btn-danger dock-leave"[^>]*aria-label=/);
    assert.match(declaration("VoiceDock", "ConnectionSignal"), /className="btn btn-ghost dock-owner"[^>]*label=/);

    assert.match(narrow, /\.mobile-topbar \.icon-btn span \{\s*display: none;/);
    assert.match(narrow, /\.dock-leave span,\s*\.dock-owner span \{\s*display: none;/);
  });

  it("lays the dock out as status above controls, and drops the row it does not need", () => {
    assert.match(narrow, /\.dock-room \{[^}]*grid-row: 1;/);
    assert.match(narrow, /\.dock-self \{[^}]*grid-row: 1;/);
    assert.match(narrow, /\.dock-controls \{[^}]*grid-column: 1 \/ -1;[^}]*grid-row: 2;/);
    assert.match(narrow, /\.dock-controls:empty \{\s*display: none;/);
    // The shell reserves the dock it actually has under it.
    assert.match(narrow, /body:has\(\.dock-controls:empty\) \.app-shell \{\s*padding-bottom: calc\(var\(--dock-quiet\) \+ 16px\);/);
  });

  it("keeps the dock controls at the documented mobile hit area", () => {
    assert.match(narrow, /\.dock-controls \.control-icon \{[^}]*height: 40px;[^}]*width: 40px;/);
  });

  it("scrolls the owner sections rather than sharing the width between them", () => {
    assert.match(narrow, /\.dash-nav \{[^}]*overflow-x: auto;/);
    assert.match(narrow, /\.dash-nav-item \{[^}]*white-space: nowrap;/);
    assert.doesNotMatch(narrow, /\.dash-nav \{[^}]*grid-auto-columns/);
  });

  it("collapses the invite ledger's wider split, which outranks the plain one", () => {
    assert.match(narrow, /\.dash-split\.is-invites,[\s\S]{0,200}?grid-template-columns: minmax\(0, 1fr\);/);
  });

  it("folds an owner table row into a card instead of a stack of full-width blocks", () => {
    assert.match(narrow, /\.dash-table-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
    assert.match(narrow, /\.dash-table-row > \.dash-cell\.is-actions \{[^}]*grid-row: 1;/);
    assert.match(narrow, /\.dash-table-row > \.dash-cell:nth-child\(3\) \{[^}]*justify-items: end;/);
  });
});

describe("phone layout", () => {
  it("keeps the account chip, which is the only way to sign out", () => {
    assert.match(declaration("VoiceDock", "ConnectionSignal"), /common\.logout/);
    assert.doesNotMatch(phone, /\.dock-self \{\s*display: none;/);
  });
});

describe("touch affordances", () => {
  it("gives sidebar menu triggers a target a finger can hit", () => {
    const coarse = mediaBlock("(pointer: coarse)", ".message-reply-trigger,");

    assert.match(coarse, /\.sidebar-menu-trigger \{\s*height: 36px;\s*width: 36px;/);
  });
});
