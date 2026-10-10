import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("voice rail live controls", () => {
  it("omits channel and participant totals from the rail", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.doesNotMatch(rail, /props\.rooms\.text\.length\s*\}\s*<\/span>\s*/);
    assert.doesNotMatch(rail, /props\.rooms\.voice\.length\s*\}\s*<\/span>\s*/);
    assert.doesNotMatch(rail, /members\.length\s*\}\s*<\/span>\s*/);
  });

  it("keeps the rail compact while retaining the speaking avatar ring", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.doesNotMatch(rail, /<VoiceStatusBadges[^>]*compact/);
    assert.match(rail, /member\.media\.speaking[\s\S]*?is-speaking/);
  });

  it("shows LIVE only for screen sharing and shares the existing member volume state", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.match(rail, /member\.media\.screen[\s\S]*?<LiveStreamPopover[\s\S]*?common\.live/);
    assert.match(rail, /<LiveStreamPopover[\s\S]*?props\.onWatchLive/);
    assert.match(
      rail,
      /<MemberActionMenu[\s\S]*?volume=\{\s*isRemote\s+\?\s+\(?props\.memberVolumes\[member\.user\.userId\]/
    );
    assert.match(rail, /props\.onMemberVolumeChange\(\s*member\.user\.userId,\s+volume\s*\)/);
    assert.match(app, /function\s+MemberActionMenu[\s\S]*?<VolumeControl/);
  });

  it("renders compact accessible mute and deafen icons for each rail member", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.match(rail, /sidebarVoiceStatusKeys\(\s*member\.media,\s+member\.moderation\s*\)/);
    assert.match(rail, /voice-channel-statuses/);
    assert.match(rail, /aria-label=\{\s*props\.t\(\s*sidebarVoiceStatusLabelKeys\[status\]\s*\)\s*\}\s*/);
    assert.match(
      rail,
      /status\s+===\s+"deafened"\s+\?\s+\(?\s*<HeadsetIcon\s+off\s+\/>\s*\)?\s*:\s+status\s+===\s+"camera"\s+\?\s+\(?\s*<CameraIcon\s+off=\{\s*false\s*\}\s+\/>\s*\)?\s*:\s+\(?\s*<MicIcon\s+off\s+\/>\s*/
    );
  });

  it("gives a live camera its own neutral rail indicator without borrowing the LIVE badge", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.match(rail, /<CameraIcon\s+off=\{\s*false\s*\}\s+\/>\s*/);
    // LIVE stays reserved for screen sharing.
    assert.doesNotMatch(rail, /member\.media\.camera[\s\S]{0,200}<LiveStreamPopover/);
    // Neutral gray by default; only owner-enforced states take the danger color.
    assert.match(styles, /\.voice-channel-status\s+\{\s*[^}]*color:\s+var\(\s*--muted\s*\)/);
    assert.match(styles, /\.voice-channel-status\.is-enforced\s+\{\s*[^}]*color:\s+var\(\s*--danger\s*\)/);
  });

  it("uses a microphone icon for voice channels", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+channelActionMenuHeight/)?.[0] ?? "";

    assert.match(rail, /className="channel-prefix"[^>]*>\s*<MicIcon\s+off=\{\s*false\s*\}\s+\/>\s*/);
    assert.doesNotMatch(rail, /className="channel-prefix">\s*vc</i);
    assert.match(
      styles,
      /\.channel-prefix\s*\{\s*[^}]*align-items:\s*center[^}]*display:\s*inline-flex[^}]*line-height:\s*1/s
    );
    assert.match(styles, /\.channel-prefix\s+\.ui-icon\s*\{\s*[^}]*display:\s*block/s);
  });

  it("automatically joins a selected broadcast with the microphone enabled", () => {
    const app = readAppSource();
    const voiceRoom = app.match(/function\s+VoiceRoomScreen[\s\S]*?\n}\n\nfunction\s+OwnerPanel/)?.[0] ?? "";

    assert.match(app, /pendingLiveWatch/);
    assert.match(voiceRoom, /props\.activeVoiceRoomId\s*===\s*viewedRoomId[\s\S]*?return[\s\S]*?props\s*\.onJoinVoice/);
    assert.match(voiceRoom, /microphoneEnabled:\s*true/);
    assert.match(voiceRoom, /visualTargets:\s*\[\{\s*publisherUserId:[^}]+kind:\s*"screen"/s);
    assert.doesNotMatch(voiceRoom, /microphoneEnabled:\s*false/);
    assert.doesNotMatch(voiceRoom, /joinAndWatchLive/);
    assert.doesNotMatch(voiceRoom, /voice\.joinAndWatch/);
  });

  it("uses the whole middle LIVE source row to reuse the sidebar watch flow", () => {
    const app = readAppSource();
    const styles = readFileSync("src/styles.css", "utf8");
    const voiceRoom = app.match(/function\s+VoiceRoomScreen[\s\S]*?\n}\n\nfunction\s+OwnerPanel/)?.[0] ?? "";
    const watchSource =
      voiceRoom.match(/const\s+watchSource\s+=\s+\(\s*source:\s+StageSource\s*\)\s+=>\s+\{\s*[\s\S]*?\n\s+};/)?.[0] ??
      "";

    assert.match(
      voiceRoom,
      /className="voice-stream-watch"[\s\S]*?onClick=\{\s*\(\s*\)\s+=>\s+selected\s+&&\s+source\.connectionStatus\s+===\s+"failed"\s+\?\s+source\.onRetry\?\.\(\s*\)\s+:\s+watchSource\(\s*source\s*\)\s*\}\s*/
    );
    assert.doesNotMatch(voiceRoom, /source-watch/);
    assert.doesNotMatch(voiceRoom, /props\.t\(\s*"voice\.watch"\s*\)/);
    assert.match(watchSource, /source\.kind\s+===\s+"screen"/);
    assert.match(watchSource, /props\.activeVoiceRoomId\s+!==\s+viewedRoomId/);
    assert.match(
      watchSource,
      /props\.onWatchLive\(\s*\{\s*[\s\S]*?serverId:\s+props\.activeServerId[\s\S]*?roomId:\s+viewedRoomId[\s\S]*?publisherUserId:\s+source\.ownerId[\s\S]*?nickname:\s+source\.ownerName/
    );
    assert.doesNotMatch(styles, /\.source-watch/);
  });
});
