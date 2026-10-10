import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("general output volume integration", () => {
  it("combines general output with participant, screen, and microphone test playback", () => {
    const source = readAppSource();

    assert.match(
      source,
      /combineOutputVolume\(\s*memberVolumes\[item\.userId\]\s+\?\?\s+DEFAULT_VOLUME_PERCENT,\s+outputVolume\s*\)/
    );
    assert.match(
      source,
      /combineOutputVolume\(\s*props.screenVolumes\[source.stream!.id\]\s+\?\?\s+DEFAULT_VOLUME_PERCENT,\s+props.audioLevels.output\s*\)/
    );
    assert.match(
      source,
      /audio\.microphoneTest\.monitorStream[\s\S]*combineOutputVolume\(\s*DEFAULT_VOLUME_PERCENT,\s+audio\.audioLevels\.output\s*\)/
    );
  });
});
