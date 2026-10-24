import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";
import { createInitialVoiceControls, moveJoinOptions, toggleVoiceControl } from "../src/lib/voiceControls.js";

const menus = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");
const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
const panel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const voiceMedia = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

describe("owner member move", () => {
  it("opens the channel list from the row, on hover and on focus alike", () => {
    assert.match(menus, /<MenuSubmenu/);
    const submenu = readFileSync("src/components/MenuSubmenu.tsx", "utf8");
    assert.match(submenu, /useHover/);
    assert.match(submenu, /useListNavigation/);
  });

  it("lists every voice room except the one the member already occupies", () => {
    assert.match(
      rail,
      /moveTargets=\{\s*canModeratePerson\s+\?\s+props\.rooms\.voice\.filter\(\s*\(\s*target\s*\)\s+=>\s*\s+target\.id\s+!==\s+room\.id\s*\)\s+:\s+undefined\s*\}/
    );
    assert.match(
      panel,
      /moveTargets=\{\s*canModeratePerson\s+&&\s+voiceRoom\s+\?\s+voiceRooms\.filter\(\s*\(\s*room\s*\)\s+=>\s*\s+room\.id\s+!==\s+voiceRoom\.id\s*\)\s+:\s+undefined\s*\}/
    );
  });

  it("offers the move only to an owner, only for a member who is in voice, and never for a bot", () => {
    // `canModeratePerson` rather than the voice answer beside it: mute, deafen
    // and disconnect mean the same thing for the Music bot and a move does not.
    // ADR-0010.
    assert.match(panel, /onMove=\{\s*canModeratePerson\s+&&\s+voiceRoom\s+\?/);
    assert.match(rail, /onMove=\{\s*canModeratePerson\s+\?/);
  });

  it("closes the menu before acting, so the flyout does not linger over the move", () => {
    assert.match(
      menus,
      /onSelect=\{\s*\(\s*roomId\s*\)\s+=>\s*\s+\{\s*\s*\n\s*actionMenu\.close\(\s*\s*\);\s*\n\s*onMove\(\s*roomId\s*\);/
    );
  });

  it("carries the move out through the ordinary join, not a bespoke path", () => {
    // The AFK room's forced mute and the automatic leave of the previous room
    // both come free that way.
    assert.match(app, /const\s+\{[^}]*\bmoveTo\b[^}]*\}\s*=\s*audio\.voice/);
    assert.match(
      app,
      /moveVoiceRef\.current\s+=\s+\(\s*roomId:\s+string\s*\)\s+=>\s*\{\s*void\s+moveTo\(\s*roomId\s*\);\s*\}/
    );
    assert.match(voiceMedia, /join\(\s*roomId,\s*\[\],\s*moveJoinOptions\(/);
  });

  it("keeps the member's own mute and deafen across the move", () => {
    // A move is the owner's instruction, not the member's choice to start
    // talking: only intentional joins may start mic-on.
    const controls = createInitialVoiceControls();
    const base = {
      moderationMuted: false,
      microphoneOnBeforeModerationMute: true,
      microphoneOnBeforeDeafen: true,
      hasLiveMicrophone: true
    };
    const selfMuted = { ...controls, mic: { ...controls.mic, on: false } };
    assert.deepEqual(moveJoinOptions({ ...base, controls: selfMuted }), { microphoneEnabled: false, deafened: false });
    assert.deepEqual(moveJoinOptions({ ...base, controls }), { microphoneEnabled: true, deafened: false });

    const selfDeafened = toggleVoiceControl(controls, "deafen");
    assert.deepEqual(moveJoinOptions({ ...base, controls: selfDeafened }), { microphoneEnabled: true, deafened: true });
    // Undeafen never acquires a microphone, so neither does a move while deafened.
    assert.deepEqual(moveJoinOptions({ ...base, controls: selfDeafened, hasLiveMicrophone: false }), {
      microphoneEnabled: false,
      deafened: true
    });

    // An owner mute is the server's to lift; the move carries the member's own
    // preference underneath it so the unmute restores it.
    const ownerMuted = { ...controls, mic: { ...controls.mic, on: false } };
    assert.deepEqual(moveJoinOptions({ ...base, controls: ownerMuted, moderationMuted: true }), {
      microphoneEnabled: true,
      deafened: false
    });
  });

  it("never opens the microphone before the join is acknowledged while deafened or owner-muted", () => {
    assert.match(
      voiceMedia,
      /desktopMicrophone\.apply\(\[track\],\s*!joinDeafened\s*&&\s*!moderationRef\.current\.muted\)/
    );
  });

  it("reserves menu height for the entry only when it is shown", () => {
    assert.match(menus, /canMove\s+\?\s+40\s+:\s+0/);
  });

  it("names the action in both languages", () => {
    assert.equal(translate("en", "member.moveTo"), "Move to");
    assert.equal(translate("tr", "member.moveTo"), "Taşı");
  });
});
