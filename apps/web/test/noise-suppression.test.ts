import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_NOISE_SUPPRESSION,
  browserSupportsNoiseSuppression,
  microphoneCaptureChange,
  microphoneProcessingConstraints,
  noiseSuppressionStorageKey,
  openMicrophoneCapture,
  readNoiseSuppression,
  supportsNoiseSuppression,
  writeNoiseSuppression
} from "../src/lib/noiseSuppression.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
}

describe("noise suppression preference", () => {
  it("defaults on so capture matches the implicit browser behaviour", () => {
    assert.equal(DEFAULT_NOISE_SUPPRESSION, true);
  });

  it("persists the preference independently per user", () => {
    const storage = memoryStorage();

    writeNoiseSuppression("user-a", false, storage);
    writeNoiseSuppression("user-b", true, storage);

    assert.equal(noiseSuppressionStorageKey("user-a"), "voxly:noise-suppression:v1:user-a");
    assert.equal(readNoiseSuppression("user-a", storage), false);
    assert.equal(readNoiseSuppression("user-b", storage), true);
    assert.equal(readNoiseSuppression("user-c", storage), DEFAULT_NOISE_SUPPRESSION);
  });

  it("falls back to the default for malformed or non-boolean values", () => {
    const storage = memoryStorage();
    storage.setItem(noiseSuppressionStorageKey("broken"), "not json");
    storage.setItem(noiseSuppressionStorageKey("numeric"), JSON.stringify(0));
    storage.setItem(noiseSuppressionStorageKey("object"), JSON.stringify({ enabled: false }));

    assert.equal(readNoiseSuppression("broken", storage), DEFAULT_NOISE_SUPPRESSION);
    assert.equal(readNoiseSuppression("numeric", storage), DEFAULT_NOISE_SUPPRESSION);
    assert.equal(readNoiseSuppression("object", storage), DEFAULT_NOISE_SUPPRESSION);
  });

  it("reads and writes safely when storage is unavailable", () => {
    assert.equal(readNoiseSuppression("user-a", undefined), DEFAULT_NOISE_SUPPRESSION);
    assert.doesNotThrow(() => writeNoiseSuppression("user-a", false, undefined));
  });

  it("keeps capture processing fixed so the preference never reopens the device", () => {
    // The constraint is not a control we can offer: Chrome runs one processing
    // module per capture, echo cancellation engages it, and `noiseSuppression:
    // false` does not reliably disengage the suppressor inside it. The
    // preference drives the capture graph instead — see `noiseGate.ts`.
    assert.deepEqual(microphoneProcessingConstraints(), {
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: true
    });
  });

  it("holds gain and echo cancellation on", () => {
    // Dropping gain costs far more than the +6 dB the input level can add back.
    // Echo cancellation off would make speaker users echo.
    assert.equal(microphoneProcessingConstraints().autoGainControl, true);
    assert.equal(microphoneProcessingConstraints().echoCancellation, true);
  });

  it("reopens for a device change and for nothing else", () => {
    assert.equal(microphoneCaptureChange({ deviceId: "mic-a" }, { deviceId: "mic-a" }), "none");
    assert.equal(microphoneCaptureChange({ deviceId: "" }, { deviceId: "" }), "none");
    assert.equal(microphoneCaptureChange({ deviceId: "mic-a" }, { deviceId: "mic-b" }), "device");
  });

  it("frees the device before reopening it so the reopen gets a new pipeline", async () => {
    const order: string[] = [];
    const stream = {} as MediaStream;
    let requested: MediaStreamConstraints | null = null;
    const mediaDevices = {
      getUserMedia(constraints: MediaStreamConstraints) {
        order.push("getUserMedia");
        requested = constraints;
        return Promise.resolve(stream);
      }
    };

    const opened = await openMicrophoneCapture(
      { deviceId: "mic-a" },
      { release: () => order.push("release"), mediaDevices }
    );

    assert.equal(opened, stream);
    // A capture that overlaps the running one is served from the pipeline that
    // is already open and silently keeps its processing.
    assert.deepEqual(order, ["release", "getUserMedia"]);
    assert.deepEqual(requested, {
      audio: { deviceId: { exact: "mic-a" }, noiseSuppression: true, autoGainControl: true, echoCancellation: true },
      video: false
    });
  });

  it("opens without a release when nothing holds the device", async () => {
    let calls = 0;
    const mediaDevices = {
      getUserMedia: () => {
        calls += 1;
        return Promise.resolve({} as MediaStream);
      }
    };

    await openMicrophoneCapture({ deviceId: "" }, { mediaDevices });

    assert.equal(calls, 1);
  });

  it("never asks a live track to change its processing", () => {
    // `applyConstraints` resolves and `getSettings` then echoes the request
    // whether or not the running capture was reconfigured, so a reconfigure
    // reports success while the audio is unchanged.
    const source = readFileSync("src/lib/noiseSuppression.ts", "utf8");

    assert.doesNotMatch(source, /\.applyConstraints\(/);
    assert.doesNotMatch(source, /\.getSettings\(/);
  });

  it("ties support to the audio graph rather than to the capture constraint", () => {
    // The constraint is requested unconditionally now, so advertising it says
    // nothing about whether the preference can be honoured.
    assert.equal(supportsNoiseSuppression(true), true);
    assert.equal(supportsNoiseSuppression(false), false);
  });

  it("probes the browser without throwing where no audio context exists", () => {
    // The test runner has no `window` at all.
    assert.equal(browserSupportsNoiseSuppression(), false);
  });
});
