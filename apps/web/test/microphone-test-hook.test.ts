import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("microphone test capture", () => {
  it("uses the selected input and shared input level for monitoring", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /getUserMedia\(buildMicrophoneConstraints\(deviceIdRef\.current, \{ noiseSuppression: noiseSuppressionRef\.current \}\)\)/);
    assert.match(source, /createMicrophoneInput\(rawStream, volumeRef\.current\)/);
    assert.match(source, /if \(sharedStreamRef\.current\) \{[\s\S]*setMonitorStream\(sharedStreamRef\.current\)/);
    assert.match(source, /setMonitorStream\(input\.monitorStream\)/);
    assert.match(source, /inputRef\.current\?\.setVolume\(volume\)/);
  });

  it("restarts a self-owned capture once for a device or noise suppression change", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /const changed = deviceIdRef\.current !== deviceId \|\| noiseSuppressionRef\.current !== noiseSuppression/);
    // A test riding the shared voice monitor owns no input and must not open a
    // second device when the voice graph re-captures.
    assert.match(source, /if \(changed && inputRef\.current\) void start\(\)/);
    assert.equal(source.match(/void start\(\)/g)?.length, 2);
  });

  it("disposes capture on stop and component cleanup", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /if \(sharedMonitorStream\) \{[\s\S]*inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /return \(\) => \{[\s\S]*stopRef\.current\(\)/);
  });
});
