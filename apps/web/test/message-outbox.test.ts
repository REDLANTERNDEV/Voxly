import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendOutboxEntry,
  messageListIds,
  removeOutboxEntry,
  setOutboxEntryStatus,
  type OutboxEntry
} from "../src/lib/messageOutbox.js";

function entry(localId: string, body: string, status: OutboxEntry["status"] = "pending"): OutboxEntry {
  return { localId, body, createdAt: "2026-08-18T10:00:00.000Z", status, replyTo: null };
}

describe("message outbox", () => {
  it("keeps composed messages in submission order", () => {
    const entries = appendOutboxEntry(appendOutboxEntry([], entry("l1", "first")), entry("l2", "second"));

    assert.deepEqual(entries.map((item) => item.body), ["first", "second"]);
  });

  it("marks only the failed entry and leaves the rest pending", () => {
    const entries = setOutboxEntryStatus(
      [entry("l1", "first"), entry("l2", "second")],
      "l1",
      "failed"
    );

    assert.deepEqual(entries.map((item) => item.status), ["failed", "pending"]);
  });

  it("drops an entry once the server acknowledges or the author discards it", () => {
    const entries = removeOutboxEntry([entry("l1", "first"), entry("l2", "second")], "l1");

    assert.deepEqual(entries.map((item) => item.localId), ["l2"]);
  });

  it("does not mutate the entries it is given", () => {
    const original = [entry("l1", "first")];

    setOutboxEntryStatus(original, "l1", "failed");
    removeOutboxEntry(original, "l1");
    appendOutboxEntry(original, entry("l2", "second"));

    assert.deepEqual(original.map((item) => item.status), ["pending"]);
    assert.equal(original.length, 1);
  });

  it("counts a local echo as an appended message so the author scrolls to it", () => {
    assert.deepEqual(
      messageListIds(["m1", "m2"], [entry("l1", "third")]),
      ["m1", "m2", "l1"]
    );
  });

  it("never reuses a server message id, so a local echo cannot collide with the broadcast", () => {
    const ids = messageListIds(["m1"], [entry("l1", "pending")]);

    assert.equal(new Set(ids).size, ids.length);
  });
});
