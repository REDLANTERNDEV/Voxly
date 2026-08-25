import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  musicIdentifierMaxLength,
  musicLinkMaxLength,
  musicTitleMaxLength,
  type MusicCommand,
  type MusicCommandKind
} from "../src/index.js";

describe("the Music bot's vocabulary", () => {
  it("is one declaration, with the names derived from it", () => {
    // There is deliberately no list of verb names beside the union. Two
    // declarations of the same vocabulary drift, and the one that drifted would
    // be a verb one side accepts and the other silently ignores. This is a
    // compile-time check with a runtime body: `Record<MusicCommandKind, true>`
    // stops building the moment a kind is added without a line here.
    const everyKind: Record<MusicCommandKind, true> = {
      add: true,
      play: true,
      stop: true,
      skip: true,
      remove: true,
      leave: true
    };

    assert.deepEqual(Object.keys(everyKind).sort(), ["add", "leave", "play", "remove", "skip", "stop"]);
  });

  it("gives every kind a member of the command union", () => {
    const commands: MusicCommand[] = [
      { kind: "add", url: "https://www.youtube.com/watch?v=aB3dE5gH7jK" },
      { kind: "play" },
      { kind: "stop" },
      { kind: "skip", entryId: "entry-1" },
      { kind: "remove", entryId: "entry-2" },
      { kind: "leave" }
    ];

    assert.deepEqual(
      commands.map((command) => command.kind).sort(),
      ["add", "leave", "play", "remove", "skip", "stop"]
    );
  });

  it("carries the link only on the verb that names one", () => {
    // The reason this is a union rather than a verb plus an optional `url`. A
    // narrowed `stop` has no `url` to read, so nothing downstream can be
    // written to expect one, and nothing can send one either.
    const command: MusicCommand = { kind: "add", url: "https://youtu.be/aB3dE5gH7jK" };

    assert.equal(command.kind === "add" && command.url, "https://youtu.be/aB3dE5gH7jK");
  });

  it("carries the entry only on the two verbs that name one", () => {
    // Same reason as the link. A narrowed `stop` has no `entryId`, so nothing
    // downstream can be written to expect one — and a skip cannot arrive
    // without the target that makes two simultaneous ones cost one Track.
    const skip: MusicCommand = { kind: "skip", entryId: "entry-1" };
    const remove: MusicCommand = { kind: "remove", entryId: "entry-2" };

    assert.equal(skip.kind === "skip" && skip.entryId, "entry-1");
    assert.equal(remove.kind === "remove" && remove.entryId, "entry-2");
  });

  it("bounds both strings the wire carries", () => {
    // One a member types, the other the source chooses — and the second is the
    // one arriving unbidden and being relayed to everyone in the room.
    assert.ok(musicLinkMaxLength > 0 && musicLinkMaxLength <= 8_192);
    assert.ok(musicTitleMaxLength > 0 && musicTitleMaxLength <= 1_000);
    // The `entryId` a skip or a removal carries is bounded by the one constant
    // every opaque identifier on this wire shares, rather than by a second one
    // beside it that could drift away from the ids the bot actually mints.
    assert.ok(musicIdentifierMaxLength > 0 && musicIdentifierMaxLength <= 256);
  });
});
