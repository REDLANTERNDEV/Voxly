import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("microphone test capture", () => {
  it("uses the selected input and shared input level for monitoring", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /openMicrophoneCapture\(\s*\{ deviceId: deviceIdRef\.current \},/);
    assert.match(source, /createMicrophoneInput\(rawStream, volumeRef\.current, \{\s*\n\s*noiseSuppression: noiseSuppressionRef\.current\s*\n\s*\}\)/);
    assert.match(source, /if \(sharedStreamRef\.current\) \{[\s\S]*setMonitorStream\(sharedStreamRef\.current\)/);
    assert.match(source, /setMonitorStream\(input\.monitorStream\)/);
    assert.match(source, /inputRef\.current\?\.setVolume\(volume\)/);
  });

  it("restarts a self-owned capture for a device change only", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /const change = microphoneCaptureChange\(\{ deviceId: deviceIdRef\.current \}, \{ deviceId \}\)/);
    // A test riding the shared voice monitor owns no input and must not open a
    // second device when the voice graph re-captures.
    assert.match(source, /if \(change === "none" \|\| !inputRef\.current\) return/);
    assert.match(source, /void start\(\);/);
  });

  it("hears a suppression change immediately, without reopening the device", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /inputRef\.current\?\.setNoiseSuppression\(noiseSuppression\)/);
    assert.doesNotMatch(source, /openMicrophoneCapture\([^)]*noiseSuppression/);
  });

  it("releases the running capture before reopening the device", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    // Disposing after the reopen would hand the new capture the pipeline that
    // is already running, processing settings and all.
    assert.match(source, /const previous = inputRef\.current;/);
    assert.match(source, /release: \(\) => previous\?\.dispose\(\)/);
    assert.doesNotMatch(source, /applyMicrophoneProcessing/);
  });

  it("disposes capture on stop and component cleanup", () => {
    const source = readFileSync("src/lib/useMicrophoneTest.ts", "utf8");

    assert.match(source, /inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /if \(sharedMonitorStream\) \{[\s\S]*inputRef\.current\?\.dispose\(\)/);
    assert.match(source, /return \(\) => \{[\s\S]*stopRef\.current\(\)/);
  });
});
