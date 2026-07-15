import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("microphone test capture", () => {
  it("uses the selected input and shared input level for monitoring", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /getUserMedia\(buildMicrophoneConstraints\(deviceIdRef\.current\)\)/);
    assert.match(source, /createMicrophoneInput\(rawStream, volumeRef\.current\)/);
    assert.match(source, /if \(sharedStreamRef\.current\) \{[\s\S]*setMonitorStream\(sharedStreamRef\.current\)/);
    assert.match(source, /setMonitorStream\(input\.monitorStream\)/);
    assert.match(source, /inputRef\.current\?\.setVolume\(volume\)/);
  });

  it("disposes capture on stop and component cleanup", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /if \(sharedMonitorStream\) \{[\s\S]*inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /return \(\) => \{[\s\S]*stopRef\.current\(\)/);
  });
});
