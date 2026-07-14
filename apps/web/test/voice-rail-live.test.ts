import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("voice rail live controls", () => {
  it("keeps the rail compact while retaining the speaking avatar ring", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.doesNotMatch(rail, /<VoiceStatusBadges[^>]*compact/);
    assert.match(rail, /member\.media\.speaking[\s\S]*?is-speaking/);
  });

  it("shows LIVE only for screen sharing and shares the existing member volume state", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.match(rail, /member\.media\.screen[\s\S]*?<LiveStreamPopover[\s\S]*?common\.live/);
    assert.match(rail, /<LiveStreamPopover[\s\S]*?props\.onWatchLive/);
    assert.match(rail, /<RailMemberActionControl[\s\S]*?volume=\{props\.memberVolumes\[member\.user\.userId\]/);
    assert.match(rail, /props\.onMemberVolumeChange\(member\.user\.userId, volume\)/);
    assert.match(app, /function RailMemberActionControl[\s\S]*?<VolumeControl/);
  });

  it("renders compact accessible mute and deafen icons for each rail member", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.match(rail, /sidebarVoiceStatusKeys\(member\.media\)/);
    assert.match(rail, /voice-channel-statuses/);
    assert.match(rail, /aria-label=\{props\.t\(`common\.\$\{status\}` as TranslationKey\)\}/);
    assert.match(rail, /status === "deafened" \? <HeadsetIcon off \/> : <MicIcon off \/>/);
  });

  it("automatically joins a selected broadcast with the microphone enabled", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const voiceRoom = app.match(/function VoiceRoomScreen[\s\S]*?\n}\n\nfunction OwnerPanel/)?.[0] ?? "";

    assert.match(app, /pendingLiveWatch/);
    assert.match(voiceRoom, /props\.activeVoiceRoomId\s*===\s*viewedRoomId[\s\S]*?return[\s\S]*?props\.onJoinVoice/);
    assert.match(voiceRoom, /microphoneEnabled:\s*true/);
    assert.match(voiceRoom, /visualTargets:\s*\[\{\s*publisherUserId:[^}]+kind:\s*"screen"/s);
    assert.doesNotMatch(voiceRoom, /microphoneEnabled:\s*false/);
    assert.doesNotMatch(voiceRoom, /joinAndWatchLive/);
    assert.doesNotMatch(voiceRoom, /voice\.joinAndWatch/);
  });
});
