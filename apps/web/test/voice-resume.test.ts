import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readVoiceResume,
  replaceVisualTarget,
  toggleVisualTarget,
  writeVoiceResume
} from "../src/lib/voiceResume.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("voice resume state", () => {
  it("restores a room and visual targets during the ten-minute window", () => {
    const storage = new MemoryStorage();
    const now = 1_000;
    const targets = [{ publisherUserId: "publisher", kind: "screen" as const }];

    writeVoiceResume(storage, "lobby", targets, now);

    assert.deepEqual(readVoiceResume(storage, now + 10 * 60 * 1000 - 1), {
      expiresAt: now + 10 * 60 * 1000,
      roomId: "lobby",
      targets
    });
  });

  it("removes an expired resume record", () => {
    const storage = new MemoryStorage();
    writeVoiceResume(storage, "lobby", [], 1_000);

    assert.equal(readVoiceResume(storage, 1_000 + 10 * 60 * 1000), null);
    assert.equal(storage.getItem("voxly:voice-resume"), null);
  });

  it("keeps the original recovery expiry when a disconnected page saves again", () => {
    const storage = new MemoryStorage();
    const expiresAt = 1_000 + 10 * 60 * 1000;
    writeVoiceResume(storage, "lobby", [], 1_000, expiresAt);
    writeVoiceResume(storage, "lobby", [], 5_000, expiresAt);

    assert.equal(readVoiceResume(storage, expiresAt - 1)?.expiresAt, expiresAt);
    assert.equal(readVoiceResume(storage, expiresAt), null);
  });

  it("replaces or toggles selected visual targets", () => {
    const camera = { publisherUserId: "cam", kind: "camera" as const };
    const screen = { publisherUserId: "screen", kind: "screen" as const };

    assert.deepEqual(replaceVisualTarget([camera], screen), [screen]);
    assert.deepEqual(toggleVisualTarget([camera], screen), [camera, screen]);
    assert.deepEqual(toggleVisualTarget([camera, screen], screen), [camera]);
  });
});
