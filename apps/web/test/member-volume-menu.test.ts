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
    assert.match(panel, /voiceRoom\s*\?\s*\([\s\S]*?<VolumeControl[\s\S]*?value=\{memberVolumes\[user\.userId\]\s*\?\?\s*DEFAULT_VOLUME_PERCENT\}/);
    assert.match(panel, /onChange=\{\(volume\) => onMemberVolumeChange\(user\.userId, volume\)\}/);
    assert.match(panel, /\{canModerate\s*\?\s*<>[\s\S]*?member\.kick[\s\S]*?member\.ban/);
  });
});
