import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_AUDIO_LEVELS,
  audioLevelStorageKey,
  combineOutputVolume,
  readAudioLevels,
  writeAudioLevels
} from "../src/lib/audioLevels.js";

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

describe("general audio levels", () => {
  it("persists independent input and output levels per user", () => {
    const storage = memoryStorage();

    writeAudioLevels("user-a", { input: 135, output: 72 }, storage);
    writeAudioLevels("user-b", { input: 85, output: 120 }, storage);

    assert.equal(audioLevelStorageKey("user-a"), "voxly:audio-levels:v1:user-a");
    assert.deepEqual(readAudioLevels("user-a", storage), { input: 135, output: 72 });
    assert.deepEqual(readAudioLevels("user-b", storage), { input: 85, output: 120 });
  });

  it("falls back safely and clamps malformed stored levels", () => {
    const storage = memoryStorage();
    storage.setItem(audioLevelStorageKey("broken"), "not json");
    storage.setItem(audioLevelStorageKey("partial"), JSON.stringify({ input: 260, output: -20 }));

    assert.deepEqual(readAudioLevels("broken", storage), DEFAULT_AUDIO_LEVELS);
    assert.deepEqual(readAudioLevels("partial", storage), { input: 200, output: 0 });
  });

  it("combines a general output level with a source level without exceeding 200 percent", () => {
    assert.equal(combineOutputVolume(100, 100), 100);
    assert.equal(combineOutputVolume(200, 50), 100);
    assert.equal(combineOutputVolume(75, 80), 60);
    assert.equal(combineOutputVolume(200, 200), 200);
  });
});
