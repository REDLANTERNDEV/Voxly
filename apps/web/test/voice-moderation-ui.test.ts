import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("voice moderation UI", () => {
  it("locks owner-enforced dock controls and suppresses participant audio", () => {
    const app = readAppSource();
    const dock = app.match(/function\s+VoiceDock[\s\S]*?\n}\n\nfunction\s+ConfirmDialog/)?.[0] ?? "";
    const globalAudio = app.match(/function\s+GlobalVoiceAudio[\s\S]*?\n}\n\nfunction\s+VisualStage/)?.[0] ?? "";

    assert.match(dock, /props\.voiceModeration\.muted/);
    assert.match(dock, /tone="danger"/);
    assert.match(dock, /props\.voiceModeration\.deafened/);
    assert.match(globalAudio, /mutedUserIds\.has\(\s*item\.userId\s*\)/);
  });

  it("offers persistent mute and deafen in owner member rows", () => {
    const app = readAppSource();
    const owner = app.match(/function\s+OwnerPanel[\s\S]*?\n}\n\nfunction\s+AppChrome/)?.[0] ?? "";

    assert.match(owner, /onVoiceModeration/);
    assert.match(owner, /moderation\.muted/);
    assert.match(owner, /moderation\.deafened/);
  });

  it("wires owner mute and deafen into left voice participant menus", () => {
    const app = readAppSource();
    const rail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+ChannelDeleteControl/)?.[0] ?? "";

    assert.match(rail, /canOwnerVoiceModerate/);
    assert.match(rail, /moderation=\{\s*canVoiceModerate\s+\?\s+member\.moderation\s+:\s+undefined\s*\}/);
    assert.match(rail, /onVoiceModeration=\{\s*canVoiceModerate/);
  });
});
