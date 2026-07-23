import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("voice moderation UI", () => {
  it("locks owner-enforced dock controls and suppresses participant audio", () => {
    const app = readAppSource();
    const dock = app.match(/function VoiceDock[\s\S]*?\n}\n\nfunction ConfirmDialog/)?.[0] ?? "";
    const globalAudio = app.match(/function GlobalVoiceAudio[\s\S]*?\n}\n\nfunction VisualStage/)?.[0] ?? "";

    assert.match(dock, /props\.voiceModeration\.muted/);
    assert.match(dock, /tone="danger"/);
    assert.match(dock, /props\.voiceModeration\.deafened/);
    assert.match(globalAudio, /mutedUserIds\.has\(item\.userId\)/);
  });

  it("offers persistent mute and deafen in owner member rows", () => {
    const app = readAppSource();
    const owner = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(owner, /onVoiceModeration/);
    assert.match(owner, /moderation\.muted/);
    assert.match(owner, /moderation\.deafened/);
  });
});
