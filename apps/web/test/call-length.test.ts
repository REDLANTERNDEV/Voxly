import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callLengthMinutes, formatCallLength, nextCallStart } from "../src/lib/callLength.js";

describe("Call length", () => {
  it("reads as minutes and seconds under an hour", () => {
    assert.equal(formatCallLength(0), "0:00");
    assert.equal(formatCallLength(7_999), "0:07");
    assert.equal(formatCallLength(247_000), "4:07");
    assert.equal(formatCallLength(3_599_000), "59:59");
  });

  it("adds hours from one hour, and keeps counting them past a day", () => {
    assert.equal(formatCallLength(3_600_000), "1:00:00");
    assert.equal(formatCallLength(3_847_000), "1:04:07");
    assert.equal(formatCallLength(93_603_000), "26:00:03");
  });

  it("never shows a negative length", () => {
    assert.equal(formatCallLength(-400), "0:00");
    assert.equal(callLengthMinutes(-400), 0);
  });

  it("speaks in whole minutes", () => {
    assert.equal(callLengthMinutes(59_999), 0);
    assert.equal(callLengthMinutes(60_000), 1);
    assert.equal(callLengthMinutes(3_847_000), 64);
  });
});

describe("Call start", () => {
  it("anchors a Call to the moment its snapshot arrived", () => {
    assert.equal(nextCallStart(undefined, 65_000, 100_000), 35_000);
  });

  it("forgets the anchor when no Call is running", () => {
    assert.equal(nextCallStart(35_000, undefined, 100_000), undefined);
  });

  it("keeps the anchor through delivery jitter, so the seconds never step back", () => {
    // A later snapshot that took 300ms longer to arrive.
    assert.equal(nextCallStart(35_000, 70_000, 105_300), 35_000);
  });

  it("re-anchors when the server disagrees by more than jitter", () => {
    assert.equal(nextCallStart(35_000, 10_000, 105_000), 95_000);
  });
});
