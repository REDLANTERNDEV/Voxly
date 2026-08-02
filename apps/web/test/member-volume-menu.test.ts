import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("member volume menus", () => {
  it("elevates open participant and member menus above adjacent content", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.voice-participants:has\(\.volume-popover\[open\]\)[^{]*\{[^}]*overflow:\s*visible[^}]*z-index:\s*var\(--layer-popover\)/s);
    assert.match(styles, /\.participant-row:has\(\.volume-popover\[open\]\)[^{]*\{[^}]*position:\s*relative[^}]*z-index:\s*var\(--layer-popover\)/s);
    assert.match(styles, /\.member-row:has\(\.member-action-menu\[open\]\)[^{]*\{[^}]*position:\s*relative[^}]*z-index:\s*var\(--layer-popover\)/s);
  });

  it("shares member volume state while retaining owner-only moderation", () => {
    const app = readAppSource();
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";
    const panel = app.match(/function MemberPanel[\s\S]*?\n}\n\nfunction VoiceDock/)?.[0] ?? "";
    const menu = app.match(/function MemberActionMenu[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.match(panel, /memberVolumes:\s*Record<string, number>/);
    assert.match(panel, /onMemberVolumeChange:\s*\(userId: string, volume: number\) => void/);
    assert.match(rail, /<MemberActionMenu/);
    assert.match(panel, /<MemberActionMenu/);
    assert.match(menu, /<VolumeControl/);
    assert.match(menu, /member\.disconnect/);
    assert.match(menu, /member\.kick/);
    assert.match(menu, /member\.ban/);
    assert.match(app, /pendingMemberAction/);
  });

  it("keeps voice status chips readable and separates owner member actions", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");

    assert.doesNotMatch(app, /return t\("room\.desktopMic"\)/);
    assert.match(app, /if \(items\.length === 0\) \{\s*return null;\s*\}/);
    assert.match(app, /className="dash-table is-members"/);
    assert.match(app, /className="dash-cell is-actions"/);
    assert.match(app, /memberRoleLabel\(member, props\.t\)/);
    assert.match(app, /member\.bannedAt \? props\.t\("common\.banned"\) : props\.t\("common\.active"\)/);
    assert.match(styles, /\.voice-status-chip\.live\s*\{[^}]*background:[^}]*color:\s*var\(--status-live-fg\)/s);
    assert.match(styles, /\.voice-status-chip\.online\s*\{[^}]*background:[^}]*color:\s*var\(--status-online-fg\)/s);
    assert.match(styles, /\.voice-status-chip\.warn\s*\{[^}]*background:[^}]*color:\s*var\(--status-warn-fg\)/s);
  });

  it("uses one explicit column contract for owner and member rows", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.dash-table\.is-members\s*\{[^}]*--dash-table-columns:/s);
    assert.match(styles, /\.dash-table-head,\s*\.dash-table-row\s*\{[^}]*grid-template-columns:\s*var\(--dash-table-columns\)/s);
    assert.doesNotMatch(styles, /\.dash-table\.is-members\s*\{[^}]*minmax\([^)]*,\s*auto\)/s);
  });

  it("lets the owner edit scoped nicknames from member surfaces", () => {
    const app = readAppSource();

    assert.match(app, /function NicknameDialog/);
    assert.match(app, /props\.onUpdateMemberNickname/);
    assert.match(app, /t\("member\.changeNickname"\)/);
    assert.match(app, /canRename/);
    assert.match(app, /currentNickname/);
  });
});
