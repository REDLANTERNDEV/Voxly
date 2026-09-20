import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultExternalPreviewPreferences,
  externalPreviewStorageKey,
  readExternalPreviewPreferences,
  saveExternalPreviewPreferences
} from "../src/lib/externalPreviewPreferences.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("external preview preferences", () => {
  it("enables every supported provider by default", () => {
    const storage = new MemoryStorage();

    assert.deepEqual(readExternalPreviewPreferences(storage, "user-a"), defaultExternalPreviewPreferences);
  });

  it("keeps provider choices isolated by account", () => {
    const storage = new MemoryStorage();

    saveExternalPreviewPreferences(storage, "user-a", {
      ...defaultExternalPreviewPreferences,
      youtube: false,
      x: false
    });

    assert.equal(readExternalPreviewPreferences(storage, "user-a").youtube, false);
    assert.equal(readExternalPreviewPreferences(storage, "user-a").x, false);
    assert.deepEqual(readExternalPreviewPreferences(storage, "user-b"), defaultExternalPreviewPreferences);
    assert.notEqual(externalPreviewStorageKey("user-a"), externalPreviewStorageKey("user-b"));
  });

  it("fails open to the documented defaults for malformed storage", () => {
    const storage = new MemoryStorage();
    storage.setItem(externalPreviewStorageKey("user-a"), "not-json");

    assert.deepEqual(readExternalPreviewPreferences(storage, "user-a"), defaultExternalPreviewPreferences);
  });
});
