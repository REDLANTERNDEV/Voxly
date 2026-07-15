import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("exclusive sidebar context menus", () => {
  it("shares one menu controller across both sidebars", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const chrome = app.match(/function AppChrome[\s\S]*?\n}\n\nfunction ChannelRail/)?.[0] ?? "";

    assert.match(chrome, /useReducer\(contextMenuReducer, null\)/);
    assert.match(chrome, /<ChannelRail[\s\S]*?actionMenu=/);
    assert.match(chrome, /<MemberPanel[\s\S]*?actionMenu=/);
  });

  it("opens actionable channel and member rows from right click or ellipsis", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";
    const members = app.match(/function MemberPanel[\s\S]*?\n}\n\nfunction RoomHeader/)?.[0] ?? "";

    assert.match(rail, /onContextMenu=/);
    assert.match(members, /onContextMenu=/);
    assert.match(app, /function SidebarMenuTrigger[\s\S]*?aria-haspopup="dialog"/);
    assert.match(rail, /<MemberActionMenu/);
    assert.match(members, /<MemberActionMenu/);
    assert.match(app, /function MemberActionMenu[\s\S]*?<SidebarMenuTrigger[\s\S]*?<ContextMenu/);
    assert.doesNotMatch(rail, /<details className="(?:channel-action-menu|rail-member-menu)/);
    assert.doesNotMatch(members, /<details className="member-action-menu/);
  });

  it("uses a reusable portal overlay and separates owner channel actions", () => {
    assert.equal(existsSync("src/components/ContextMenu.tsx"), true);
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.channel-row\s*\{[^}]*gap:\s*4px/s);
    assert.match(styles, /\.sidebar-menu-trigger/);
    assert.match(styles, /\.sidebar-context-menu/);
  });
});
