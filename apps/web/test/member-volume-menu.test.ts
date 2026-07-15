import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("member volume menus", () => {
  it("elevates open participant and member menus above adjacent content", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.voice-participants:has\(\.volume-popover\[open\]\)[^{]*\{[^}]*overflow:\s*visible[^}]*z-index:\s*var\(--layer-popover\)/s);
    assert.match(styles, /\.participant-row:has\(\.volume-popover\[open\]\)[^{]*\{[^}]*position:\s*relative[^}]*z-index:\s*var\(--layer-popover\)/s);
    assert.match(styles, /\.member-row:has\(\.member-action-menu\[open\]\)[^{]*\{[^}]*position:\s*relative[^}]*z-index:\s*var\(--layer-popover\)/s);
  });

  it("shares member volume state while retaining owner-only moderation", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const panel = app.match(/function MemberPanel[\s\S]*?\n}\n\nfunction VoiceDock/)?.[0] ?? "";

    assert.match(panel, /memberVolumes:\s*Record<string, number>/);
    assert.match(panel, /onMemberVolumeChange:\s*\(userId: string, volume: number\) => void/);
    assert.match(panel, /voiceRoom\s*&&\s*user\.userId\s*!==\s*currentUser\.id\s*\?\s*\([\s\S]*?<VolumeControl[\s\S]*?value=\{memberVolumes\[user\.userId\]\s*\?\?\s*DEFAULT_VOLUME_PERCENT\}/);
    assert.match(panel, /onChange=\{\(volume\) => onMemberVolumeChange\(user\.userId, volume\)\}/);
    assert.match(panel, /\{canModerate\s*&&\s*user\.userId\s*!==\s*currentUser\.id\s*\?\s*<>[\s\S]*?member\.kick[\s\S]*?member\.ban/);
  });

  it("keeps voice status chips readable and separates owner member actions", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.doesNotMatch(app, /return t\("room\.desktopMic"\)/);
    assert.match(app, /if \(items\.length === 0\) \{\s*return null;\s*\}/);
    assert.match(app, /className="owner-grid members-grid"/);
    assert.match(app, /className="table-actions"/);
    assert.match(app, /item\.role === "owner" \? props\.t\("common\.owner"\) : props\.t\("common\.user"\)/);
    assert.match(app, /item\.bannedAt \? props\.t\("common\.banned"\) : props\.t\("common\.active"\)/);
    assert.match(styles, /\.voice-status-chip\.live\s*\{[^}]*background:[^}]*color:\s*var\(--status-live-fg\)/s);
    assert.match(styles, /\.voice-status-chip\.online\s*\{[^}]*background:[^}]*color:\s*var\(--status-online-fg\)/s);
    assert.match(styles, /\.voice-status-chip\.warn\s*\{[^}]*background:[^}]*color:\s*var\(--status-warn-fg\)/s);
    assert.match(styles, /\.table-actions\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap[^}]*gap:/s);
  });

  it("uses one explicit column contract for owner and member rows", () => {
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(styles, /\.owner-grid\.members-grid\s*\{[^}]*--member-table-columns:/s);
    assert.match(styles, /\.members-grid \.table-head,\s*\.members-grid \.table-row\s*\{[^}]*grid-template-columns:\s*var\(--member-table-columns\)/s);
    assert.doesNotMatch(styles, /\.members-grid \.table-head,[\s\S]*?minmax\([^)]*,\s*auto\)/);
  });

  it("lets the owner edit scoped nicknames from member surfaces", () => {
    const app = readFileSync("src/App.tsx", "utf8");

    assert.match(app, /function NicknameDialog/);
    assert.match(app, /props\.onUpdateMemberNickname/);
    assert.match(app, /t\("member\.changeNickname"\)/);
    assert.match(app, /canRename/);
    assert.match(app, /currentNickname/);
  });
});
