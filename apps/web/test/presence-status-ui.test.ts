import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";
import { memberPresenceState } from "../src/lib/memberDirectory.js";

const memberPanel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
const workspace = readFileSync("src/app/useWorkspaceController.ts", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("member presence state", () => {
  it("derives three states from the list a member is in plus their reported status", () => {
    assert.equal(memberPresenceState({ status: "online" }, true), "online");
    assert.equal(memberPresenceState({ status: "idle" }, true), "idle");
    assert.equal(memberPresenceState({}, true), "online", "an absent status is not away");
  });

  it("reports offline for anyone outside the online list, whatever they last said", () => {
    // Offline is the absence of a presence entry, so a stale idle flag on a
    // disconnected member must not outrank it.
    assert.equal(memberPresenceState({ status: "idle" }, false), "offline");
    assert.equal(memberPresenceState({ status: "online" }, false), "offline");
  });
});

describe("presence dots", () => {
  it("renders one dot per member row, labelled for screen readers", () => {
    assert.match(memberPanel, /className=\{`presence-dot is-\$\{memberPresenceState\(user, online\)\}`\}/);
    assert.match(memberPanel, /aria-label=\{t\(`presence\.\$\{memberPresenceState\(user, online\)\}` as const\)\}/);
  });

  it("gives each state its own colour rather than relying on position alone", () => {
    assert.match(styles, /\.presence-dot\.is-online \{ background: var\(--speaking\); \}/);
    assert.match(styles, /\.presence-dot\.is-idle \{ background: #e0a326; \}/);
    assert.match(styles, /\.presence-dot\.is-offline \{[^}]*var\(--muted\)/);
  });

  it("rings the dot in the panel background so it cannot merge into the avatar", () => {
    assert.match(styles, /\.presence-dot \{[^}]*border: 2px solid var\(--surface\)/);
  });
});

describe("presence status updates", () => {
  it("never promotes an offline member into the online list", () => {
    assert.match(workspace, /if \(!present\?\.some\(\(item\) => item\.userId === userId\)\) return current;/);
  });
});

describe("presence localization", () => {
  it("names all three states in both languages", () => {
    for (const key of ["presence.online", "presence.idle", "presence.offline"] as const) {
      assert.ok(translate("en", key).length > 0);
      assert.ok(translate("tr", key).length > 0);
    }
    assert.equal(translate("tr", "presence.idle"), "Boşta");
  });

  it("localizes the owner's AFK timeout control", () => {
    assert.equal(translate("en", "owner.afkTimeoutMinutes", { count: 30 }), "30 minutes");
    assert.equal(translate("tr", "owner.afkTimeoutHours", { count: 2 }), "2 saat");
    assert.notEqual(translate("en", "owner.afkTimeoutHint"), translate("tr", "owner.afkTimeoutHint"));
  });
});
