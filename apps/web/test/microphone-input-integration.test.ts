import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("voice microphone input gain integration", () => {
  it("processes newly captured microphones before voice publication", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /microphoneVolume\?: number/);
    assert.match(source, /createMicrophoneInput\(rawStream, microphoneVolumeRef\.current, \{\s*\n\s*noiseSuppression: noiseSuppressionRef\.current\s*\n\s*\}\)/);
    assert.match(source, /localStreamsRef\.current\.mic = input\.voiceStream/);
    assert.match(source, /setMicrophoneMonitorStream\(input\.monitorStream\)/);
    assert.match(source, /watchMicrophoneStreamEnd\(input\.rawStream/);
  });

  it("updates the active microphone graph when the general input level changes", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /microphoneVolumeRef\.current = microphoneVolume/);
    assert.match(source, /microphoneInputRef\.current\?\.setVolume\(microphoneVolume\)/);
  });
});
