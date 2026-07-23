import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("voice rail live controls", () => {
  it("omits channel and participant totals from the rail", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.doesNotMatch(rail, /props\.rooms\.text\.length\}<\/span>/);
    assert.doesNotMatch(rail, /props\.rooms\.voice\.length\}<\/span>/);
    assert.doesNotMatch(rail, /members\.length\}<\/span>/);
  });

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
    assert.match(rail, /<MemberActionMenu[\s\S]*?volume=\{isRemote \? props\.memberVolumes\[member\.user\.userId\]/);
    assert.match(rail, /props\.onMemberVolumeChange\(member\.user\.userId, volume\)/);
    assert.match(app, /function MemberActionMenu[\s\S]*?<VolumeControl/);
  });

  it("renders compact accessible mute and deafen icons for each rail member", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.match(rail, /sidebarVoiceStatusKeys\(member\.media\)/);
    assert.match(rail, /voice-channel-statuses/);
    assert.match(rail, /aria-label=\{props\.t\(`common\.\$\{status\}` as TranslationKey\)\}/);
    assert.match(rail, /status === "deafened" \? <HeadsetIcon off \/> : <MicIcon off \/>/);
  });

  it("uses a microphone icon for voice channels", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelCreateControl/)?.[0] ?? "";

    assert.match(rail, /className="channel-prefix"[^>]*><MicIcon off=\{false\} \/>/);
    assert.doesNotMatch(rail, /className="channel-prefix">vc</i);
    assert.match(styles, /\.channel-prefix\s*\{[^}]*align-items:\s*center[^}]*display:\s*inline-flex[^}]*line-height:\s*1/s);
    assert.match(styles, /\.channel-prefix \.ui-icon\s*\{[^}]*display:\s*block/s);
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

  it("uses the whole middle LIVE source row to reuse the sidebar watch flow", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");
    const voiceRoom = app.match(/function VoiceRoomScreen[\s\S]*?\n}\n\nfunction OwnerPanel/)?.[0] ?? "";
    const watchSource = voiceRoom.match(/const watchSource = \(source: StageSource\) => \{[\s\S]*?\n  };/)?.[0] ?? "";

    assert.match(voiceRoom, /className="visual-source-main"[\s\S]*?onClick=\{\(\) => watchSource\(source\)\}/);
    assert.doesNotMatch(voiceRoom, /source-watch/);
    assert.doesNotMatch(voiceRoom, /props\.t\("voice\.watch"\)/);
    assert.match(watchSource, /source\.kind === "screen"/);
    assert.match(watchSource, /props\.activeVoiceRoomId !== viewedRoomId/);
    assert.match(watchSource, /props\.onWatchLive\(\{[\s\S]*?serverId: props\.activeServerId[\s\S]*?roomId: viewedRoomId[\s\S]*?publisherUserId: source\.ownerId[\s\S]*?nickname: source\.ownerName/);
    assert.doesNotMatch(styles, /\.source-watch/);
  });
});
