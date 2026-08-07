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

  it("changes suppression alone", () => {
    assert.deepEqual(microphoneProcessingConstraints(true), { noiseSuppression: true, autoGainControl: true, echoCancellation: true });
    assert.deepEqual(microphoneProcessingConstraints(false), { noiseSuppression: false, autoGainControl: true, echoCancellation: true });
  });

  it("holds gain and echo cancellation steady across the preference", () => {
    // Dropping gain with suppression costs far more than the +6 dB the input
    // level can add back, and the drop hides the raw noise the preference is
    // there to expose. Echo cancellation off would make speaker users echo.
    for (const enabled of [true, false]) {
      assert.equal(microphoneProcessingConstraints(enabled).autoGainControl, true);
      assert.equal(microphoneProcessingConstraints(enabled).echoCancellation, true);
    }
  });

  it("separates a device change from a processing change", () => {
    const settings = (deviceId: string, noiseSuppression: boolean) => ({ deviceId, noiseSuppression });

    assert.equal(microphoneCaptureChange(settings("mic-a", true), settings("mic-a", true)), "none");
    assert.equal(microphoneCaptureChange(settings("", false), settings("", false)), "none");
    assert.equal(microphoneCaptureChange(settings("mic-a", true), settings("mic-a", false)), "processing");
    assert.equal(microphoneCaptureChange(settings("mic-a", true), settings("mic-b", true)), "device");
    // A device change already reopens the capture, so it carries the processing
    // with it and must not be reported as the narrower change.
    assert.equal(microphoneCaptureChange(settings("mic-a", true), settings("mic-b", false)), "device");
  });

  it("frees the device before reopening it so the new processing takes", async () => {
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
      { deviceId: "mic-a", noiseSuppression: false },
      { release: () => order.push("release"), mediaDevices }
    );

    assert.equal(opened, stream);
    // A capture that overlaps the running one is served from the pipeline that
    // is already open and silently keeps its processing.
    assert.deepEqual(order, ["release", "getUserMedia"]);
    assert.deepEqual(requested, {
      audio: { deviceId: { exact: "mic-a" }, noiseSuppression: false, autoGainControl: true, echoCancellation: true },
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

    await openMicrophoneCapture({ deviceId: "", noiseSuppression: true }, { mediaDevices });

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

  it("detects support only from an explicit supported constraint", () => {
    assert.equal(supportsNoiseSuppression({ noiseSuppression: true }), true);
    assert.equal(supportsNoiseSuppression({ noiseSuppression: false }), false);
    assert.equal(supportsNoiseSuppression({}), false);
    assert.equal(supportsNoiseSuppression(null), false);
    assert.equal(supportsNoiseSuppression(undefined), false);
  });

  it("probes the browser without throwing where mediaDevices is absent", () => {
    // Insecure origins expose no `navigator.mediaDevices`, and the test runner
    // has no `navigator` at all.
    assert.equal(browserSupportsNoiseSuppression(), false);
  });
});
