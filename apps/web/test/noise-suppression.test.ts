import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_NOISE_SUPPRESSION,
  applyMicrophoneProcessing,
  browserSupportsNoiseSuppression,
  microphoneProcessingConstraints,
  noiseSuppressionStorageKey,
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

  it("moves automatic gain control together with suppression", () => {
    // Gain control left on over an unsuppressed signal pumps the voice.
    assert.deepEqual(microphoneProcessingConstraints(true), { noiseSuppression: true, autoGainControl: true });
    assert.deepEqual(microphoneProcessingConstraints(false), { noiseSuppression: false, autoGainControl: false });
  });

  it("treats a live reconfiguration as applied only when the settings agree", async () => {
    const track = (settings: MediaTrackSettings, fail = false) => ({
      applyConstraints: () => fail ? Promise.reject(new Error("nope")) : Promise.resolve(),
      getSettings: () => settings
    });

    assert.equal(await applyMicrophoneProcessing(track({ noiseSuppression: false, autoGainControl: false }), false), true);
    // A browser that resolves without reconfiguring must not be trusted.
    assert.equal(await applyMicrophoneProcessing(track({ noiseSuppression: true, autoGainControl: true }), false), false);
    // A partial application still requires a full re-capture.
    assert.equal(await applyMicrophoneProcessing(track({ noiseSuppression: false, autoGainControl: true }), false), false);
    // Browsers that do not report the settings at all fall back.
    assert.equal(await applyMicrophoneProcessing(track({}), false), false);
    assert.equal(await applyMicrophoneProcessing(track({}, true), false), false);
    assert.equal(await applyMicrophoneProcessing(null, false), false);
    assert.equal(await applyMicrophoneProcessing(undefined, true), false);
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
