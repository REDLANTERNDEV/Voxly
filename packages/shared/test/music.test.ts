import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { musicCommands, type MusicCommand } from "../src/index.js";

describe("the Music bot's vocabulary", () => {
  it("is the three verbs, in one list both sides read", () => {
    // The server validates an incoming `music:control` against this list and
    // the bot switches on the type derived from it. A second copy anywhere
    // would be a verb one side accepts and the other silently ignores.
    assert.deepEqual([...musicCommands], ["play", "stop", "leave"]);
  });

  it("derives the type from the list rather than restating it", () => {
    // A compile-time check with a runtime body: if `MusicCommand` were ever
    // spelled out separately and the two drifted, this stops building.
    const everyCommand: Record<MusicCommand, true> = { play: true, stop: true, leave: true };

    assert.deepEqual(Object.keys(everyCommand).sort(), [...musicCommands].sort());
  });
});
