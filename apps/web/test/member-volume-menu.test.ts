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

  it("offers persisted volume for remote directory members outside voice", () => {
    const app = readAppSource();
    const panel = app.match(/function MemberPanel[\s\S]*?\n}\n\nfunction VoiceDock/)?.[0] ?? "";

    assert.match(panel, /const hasRemoteActions = user\.userId !== currentUser\.id;/);
    assert.match(panel, /hasVolume: user\.userId !== currentUser\.id,/);
    assert.match(panel, /volume=\{user\.userId !== currentUser\.id \? memberVolumes\[user\.userId\] \?\? DEFAULT_VOLUME_PERCENT : undefined\}/);
    assert.match(panel, /onVolumeChange=\{user\.userId !== currentUser\.id \? \(volume\) => onMemberVolumeChange\(user\.userId, volume\) : undefined\}/);
  });

  it("says a participant's state with marks and separates owner member actions", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");

    assert.doesNotMatch(app, /return t\("room\.desktopMic"\)/);
    assert.match(app, /if \(items\.length === 0\) \{\s*return null;\s*\}/);
    assert.match(app, /className="dash-table is-members"/);
    assert.match(app, /className="dash-cell is-actions"/);
    assert.match(app, /memberRoleLabel\(member, props\.t\)/);
    assert.match(app, /member\.bannedAt \? props\.t\("common\.banned"\) : props\.t\("common\.active"\)/);
    // The mark dropped its label, so the label has to survive as the name.
    assert.match(app, /className=\{`voice-status-icon is-\$\{item\.tone\}`\}[^>]*aria-label=\{item\.label\} title=\{item\.label\}/);
    // Red is an owner's doing; everything a member did to themselves is grey.
    assert.match(styles, /\.voice-status-icon \{[^}]*color: var\(--muted\)/s);
    assert.match(styles, /\.voice-status-icon\.is-danger \{\s*color: var\(--danger\);/);
    // And it stays out of the nickname's line.
    assert.doesNotMatch(app, /<span className="participant-copy">[^\n]*<VoiceStatusBadges/);
    assert.match(app, /className="participant-status"[\s\S]{0,200}?<VoiceStatusBadges/);
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
