import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("microphone test capture", () => {
  it("uses the selected input and shared input level for monitoring", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /getUserMedia\(buildMicrophoneConstraints\(deviceIdRef\.current, microphoneProcessingConstraints\(noiseSuppressionRef\.current\)\)\)/);
    assert.match(source, /createMicrophoneInput\(rawStream, volumeRef\.current\)/);
    assert.match(source, /if \(sharedStreamRef\.current\) \{[\s\S]*setMonitorStream\(sharedStreamRef\.current\)/);
    assert.match(source, /setMonitorStream\(input\.monitorStream\)/);
    assert.match(source, /inputRef\.current\?\.setVolume\(volume\)/);
  });

  it("restarts a self-owned capture only when the device changes", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    // A test riding the shared voice monitor owns no input and must not open a
    // second device when the voice graph re-captures.
    assert.match(source, /if \(!input \|\| \(!deviceChanged && !processingChanged\)\) return/);
    assert.match(source, /if \(deviceChanged\) \{\s*\n\s*void start\(\);/);
  });

  it("reconfigures the live monitor capture instead of reopening it for processing", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    // Reopening the device mid-monitor makes the echo canceller re-converge,
    // which the listener hears.
    assert.match(source, /applyMicrophoneProcessing\(input\.rawStream\.getAudioTracks\(\)\[0\], noiseSuppression\)/);
    assert.match(source, /if \(reconfigured \|\| generation !== generationRef\.current \|\| inputRef\.current !== input\) return/);
  });

  it("disposes capture on stop and component cleanup", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /if \(sharedMonitorStream\) \{[\s\S]*inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /return \(\) => \{[\s\S]*stopRef\.current\(\)/);
  });
});
