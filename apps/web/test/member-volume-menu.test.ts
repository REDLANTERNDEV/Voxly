import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("member volume menus", () => {
  it("elevates open participant and member menus above adjacent content", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(
      styles,
      /\.voice-participants:has\(\s*\.volume-popover\[open\]\s*\)[^{]*\{\s*[^}]*overflow:\s*visible[^}]*z-index:\s*var\(\s*--layer-popover\s*\)/s
    );
    assert.match(
      styles,
      /\.participant-row:has\(\s*\.volume-popover\[open\]\s*\)[^{]*\{\s*[^}]*position:\s*relative[^}]*z-index:\s*var\(\s*--layer-popover\s*\)/s
    );
    assert.match(
      styles,
      /\.member-row:has\(\s*\.member-action-menu\[open\]\s*\)[^{]*\{\s*[^}]*position:\s*relative[^}]*z-index:\s*var\(\s*--layer-popover\s*\)/s
    );
  });

  it("shares member volume state while retaining owner-only moderation", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+ChannelDeleteControl/)?.[0] ?? "";
    const panel = app.match(/function\s+MemberPanel[\s\S]*?\n}\n\nfunction\s+VoiceDock/)?.[0] ?? "";
    const menu = app.match(/function\s+MemberActionMenu[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.match(panel, /memberVolumes:\s*Record<string,\s+number>\s*/);
    assert.match(panel, /onMemberVolumeChange:\s*\(\s*userId:\s+string,\s+volume:\s+number\s*\)\s+=>\s+void/);
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
    const panel = app.match(/function\s+MemberPanel[\s\S]*?\n}\n\nfunction\s+VoiceDock/)?.[0] ?? "";

    assert.match(panel, /const\s+hasRemoteActions\s+=\s+user\.userId\s+!==\s+currentUser\.id;/);
    assert.match(panel, /hasVolume:\s+user\.userId\s+!==\s+currentUser\.id,/);
    assert.match(
      panel,
      /volume=\{\s*user\.userId\s+!==\s+currentUser\.id\s+\?\s+\(?memberVolumes\[user\.userId\]\s+\?\?\s+DEFAULT_VOLUME_PERCENT\)?\s+:\s+undefined\s*\}\s*/
    );
    assert.match(
      panel,
      /onVolumeChange=\{\s*user\.userId\s+!==\s+currentUser\.id\s+\?\s+\(\s*volume\s*\)\s+=>\s+onMemberVolumeChange\(\s*user\.userId,\s+volume\s*\)\s+:\s+undefined\s*\}\s*/
    );
  });

  it("says a participant's state with marks and separates owner member actions", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");

    assert.doesNotMatch(app, /return\s+t\(\s*"room\.desktopMic"\s*\)/);
    assert.match(app, /if\s+\(\s*items\.length\s+===\s+0\s*\)\s+\{\s*return\s+null;\s*\}\s*/);
    assert.match(app, /className="dash-table\s+is-members"/);
    assert.match(app, /className="dash-cell\s+is-actions"/);
    assert.match(app, /memberRoleLabel\(\s*member,\s+props\.t\s*\)/);
    assert.match(
      app,
      /member\.bannedAt\s+\?\s+props\.t\(\s*"common\.banned"\s*\)\s+:\s+props\.t\(\s*"common\.active"\s*\)/
    );
    // The mark dropped its label, so the label has to survive as the name.
    assert.match(
      app,
      /className=\{\s*`voice-status-icon\s+is-\$\{\s*item\.tone\s*\}\s*`\s*\}\s*[^>]*aria-label=\{\s*item\.label\s*\}\s+title=\{\s*item\.label\s*\}\s*/
    );
    // Red is an owner's doing; everything a member did to themselves is grey.
    assert.match(styles, /\.voice-status-icon\s+\{\s*[^}]*color:\s+var\(\s*--muted\s*\)/s);
    assert.match(styles, /\.voice-status-icon\.is-danger\s+\{\s*color:\s+var\(\s*--danger\s*\);/);
    // And it stays out of the nickname's line.
    assert.doesNotMatch(app, /<span\s+className="participant-copy">\s*[^\n]*<VoiceStatusBadges/);
    assert.match(app, /className="voice-tile-caption"[\s\S]{0,200}?<VoiceStatusBadges/);
  });

  it("uses one explicit column contract for owner and member rows", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.dash-table\.is-members\s*\{\s*[^}]*--dash-table-columns:/s);
    assert.match(
      styles,
      /\.dash-table-head,\s*\.dash-table-row\s*\{\s*[^}]*grid-template-columns:\s*var\(\s*--dash-table-columns\s*\)/s
    );
    assert.doesNotMatch(styles, /\.dash-table\.is-members\s*\{\s*[^}]*minmax\(\s*[^)]*,\s*auto\s*\)/s);
  });

  it("lets the owner edit scoped nicknames from member surfaces", () => {
    const app = readAppSource();

    assert.match(app, /function\s+NicknameDialog/);
    assert.match(app, /props\.onUpdateMemberNickname/);
    assert.match(app, /t\(\s*"member\.changeNickname"\s*\)/);
    assert.match(app, /canRename/);
    assert.match(app, /currentNickname/);
  });
});
