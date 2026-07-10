import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_VOLUME_PERCENT,
  clampVolumePercent,
  pruneVolumes,
  readUserVolumes,
  setVolume,
  userVolumeStorageKey,
  volumeGain,
  writeUserVolumes
} from "../src/lib/voiceVolume.js";

function createStorage() {
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

describe("voice volume preferences", () => {
  it("clamps volume percentages to the supported integer range", () => {
    assert.equal(clampVolumePercent(-1), 0);
    assert.equal(clampVolumePercent(100.8), 101);
    assert.equal(clampVolumePercent(201), 200);
    assert.equal(DEFAULT_VOLUME_PERCENT, 100);
  });

  it("persists levels for the listener without leaking them to another listener", () => {
    const storage = createStorage();
    writeUserVolumes("listener-a", { "remote-1": 145 }, storage);

    assert.equal(userVolumeStorageKey("listener-a"), "voxly:voice-volumes:v1:listener-a");
    assert.deepEqual(readUserVolumes("listener-a", storage), { "remote-1": 145 });
    assert.deepEqual(readUserVolumes("listener-b", storage), {});
  });

  it("drops invalid entries and leaves old state unchanged while updating", () => {
    const storage = createStorage();
    storage.setItem(userVolumeStorageKey("listener-a"), '{"remote-1":"loud","remote-2":260}');
    const original = { "remote-1": 100 };

    assert.deepEqual(readUserVolumes("listener-a", storage), { "remote-2": 200 });
    assert.deepEqual(setVolume(original, "remote-1", 75), { "remote-1": 75 });
    assert.deepEqual(original, { "remote-1": 100 });
  });

  it("removes temporary levels for screen streams that ended", () => {
    assert.deepEqual(pruneVolumes({ "screen-a": 80, "screen-b": 160 }, ["screen-b"]), { "screen-b": 160 });
  });

  it("converts levels into Web Audio gain values", () => {
    assert.equal(volumeGain(0), 0);
    assert.equal(volumeGain(100), 1);
    assert.equal(volumeGain(200), 2);
    assert.equal(volumeGain(500), 2);
  });
});
