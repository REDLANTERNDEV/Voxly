import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { readAppSource } from "./app-source.js";

describe("general output volume integration", () => {
  it("combines general output with participant, screen, and microphone test playback", () => {
    const source = readAppSource();

    assert.match(source, /combineOutputVolume\(memberVolumes\[item\.userId\] \?\? DEFAULT_VOLUME_PERCENT, outputVolume\)/);
    assert.match(source, /combineOutputVolume\(focusedVolume, outputVolume\)/);
    assert.match(source, /audio\.microphoneTest\.monitorStream[\s\S]*combineOutputVolume\(DEFAULT_VOLUME_PERCENT, audio\.audioLevels\.output\)/);
  });
});
