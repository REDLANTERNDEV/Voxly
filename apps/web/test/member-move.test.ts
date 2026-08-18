import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";

const menus = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");
const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
const panel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("owner member move", () => {
  it("opens the channel list from the row, on hover and on focus alike", () => {
    assert.match(menus, /\.menu-submenu|menu-submenu-panel/);
    assert.match(styles, /\.menu-submenu:hover \.menu-submenu-panel,\s*\n\s*\.menu-submenu:focus-within \.menu-submenu-panel \{[\s\S]*?display: grid;/);
  });

  it("lists every voice room except the one the member already occupies", () => {
    assert.match(rail, /moveTargets=\{canModerate \? props\.rooms\.voice\.filter\(\(target\) => target\.id !== room\.id\) : undefined\}/);
    assert.match(panel, /moveTargets=\{canModerateRemote && voiceRoom \? voiceRooms\.filter\(\(room\) => room\.id !== voiceRoom\.id\) : undefined\}/);
  });

  it("offers the move only to an owner, and only for a member who is in voice", () => {
    assert.match(panel, /onMove=\{canModerateRemote && voiceRoom \?/);
    assert.match(rail, /onMove=\{canModerate \?/);
  });

  it("closes the menu before acting, so the flyout does not linger over the move", () => {
    assert.match(menus, /onSelect=\{\(roomId\) => \{\s*\n\s*actionMenu\.close\(\);\s*\n\s*onMove\(roomId\);/);
  });

  it("carries the move out through the ordinary join, not a bespoke path", () => {
    // The AFK room's forced mute and the automatic leave of the previous room
    // both come free that way.
    assert.match(app, /moveVoiceRef\.current = \(roomId: string\) => \{ void audio\.voice\.join\(roomId, \[\], \{\}\); \}/);
  });

  it("reserves menu height for the entry only when it is shown", () => {
    assert.match(menus, /canMove \? 40 : 0/);
  });

  it("names the action in both languages", () => {
    assert.equal(translate("en", "member.moveTo"), "Move to");
    assert.equal(translate("tr", "member.moveTo"), "Taşı");
  });
});
