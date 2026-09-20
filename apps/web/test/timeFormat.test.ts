import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readTimeFormatPreference,
  saveTimeFormatPreference,
  timeFormatOptions,
  timeFormatStorageKey
} from "../src/lib/timeFormat.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("time format preference", () => {
  it("defaults malformed and missing device preferences to auto", () => {
    const storage = new MemoryStorage();

    assert.equal(readTimeFormatPreference(storage), "auto");
    storage.setItem(timeFormatStorageKey, "unexpected");
    assert.equal(readTimeFormatPreference(storage), "auto");
  });

  it("persists an explicit device preference", () => {
    const storage = new MemoryStorage();

    saveTimeFormatPreference(storage, "24");

    assert.equal(readTimeFormatPreference(storage), "24");
  });

  it("uses the device cycle for auto independently of the interface locale", () => {
    assert.deepEqual(timeFormatOptions("auto", "h12"), { hourCycle: "h12" });
    assert.deepEqual(timeFormatOptions("auto", "h23"), { hourCycle: "h23" });
  });

  it("maps explicit choices without consulting the device cycle", () => {
    assert.deepEqual(timeFormatOptions("12", "h23"), { hourCycle: "h12" });
    assert.deepEqual(timeFormatOptions("24", "h12"), { hourCycle: "h23" });
  });
});
