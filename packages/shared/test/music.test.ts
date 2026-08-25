import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  musicIdentifierMaxLength,
  musicInputMaxLength,
  musicSearchResultsMax,
  musicTitleMaxLength,
  type MusicAnswer,
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
      { kind: "add", input: "https://www.youtube.com/watch?v=aB3dE5gH7jK" },
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

  it("carries what a member typed only on the verb that takes it", () => {
    // The reason this is a union rather than a verb plus an optional field. A
    // narrowed `stop` has no `input` to read, so nothing downstream can be
    // written to expect one, and nothing can send one either.
    const command: MusicCommand = { kind: "add", input: "https://youtu.be/aB3dE5gH7jK" };

    assert.equal(command.kind === "add" && command.input, "https://youtu.be/aB3dE5gH7jK");
  });

  it("takes a name on the same field as a link, because the bot decides which it is", () => {
    // Not two verbs, and not two controls. Which of the two a string is is the
    // bot's knowledge — a browser that guessed would be the copy that drifts —
    // so both travel on one field and the answer says which happened.
    const typed: MusicCommand = { kind: "add", input: "nocturne in e flat" };

    assert.equal(typed.kind === "add" && typed.input, "nocturne in e flat");
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
    assert.ok(musicInputMaxLength > 0 && musicInputMaxLength <= 8_192);
    assert.ok(musicTitleMaxLength > 0 && musicTitleMaxLength <= 1_000);
    // The `entryId` a skip or a removal carries is bounded by the one constant
    // every opaque identifier on this wire shares, rather than by a second one
    // beside it that could drift away from the ids the bot actually mints.
    assert.ok(musicIdentifierMaxLength > 0 && musicIdentifierMaxLength <= 256);
  });

  it("bounds how many Results a search may answer with", () => {
    // A title is somebody else's string arriving unbidden; a list of them is
    // the same problem several times over. Short as well as bounded, because
    // the list sits above the Queue in a panel that owns no scroll region.
    assert.ok(musicSearchResultsMax > 1 && musicSearchResultsMax <= 10);
  });
});

describe("what the bot answers", () => {
  it("keeps the Track and the Results apart rather than making both optional", () => {
    // Two nullable fields where exactly one is ever filled is the shape this
    // contract already refused for the command union: nothing would stop an
    // answer arriving as both, or as neither.
    const queued: MusicAnswer = { ok: true, kind: "track", track: { id: "aB3dE5gH7jK", title: "Nocturne", durationSeconds: 273 } };
    const offered: MusicAnswer = {
      ok: true,
      kind: "results",
      results: [{
        track: { id: "aB3dE5gH7jK", title: "Nocturne", durationSeconds: 273 },
        channel: "A Channel",
        url: "https://www.youtube.com/watch?v=aB3dE5gH7jK"
      }]
    };

    assert.equal(queued.kind === "track" && queued.track?.title, "Nocturne");
    assert.equal(offered.kind === "results" && offered.results[0]?.channel, "A Channel");
  });

  it("says there is no Track explicitly, rather than by leaving the field out", () => {
    // A caller that forgets to handle "there is no Track" should be made to say
    // so. `play`, `stop`, `skip`, `remove` and `leave` all answer this way.
    const nothing: MusicAnswer = { ok: true, kind: "track", track: null };

    assert.equal(nothing.kind === "track" && nothing.track, null);
  });

  it("lets a search answer with nothing found, which is not a refusal", () => {
    // Nothing failed and there is nothing for the member to wait out, so this
    // is an answer the panel puts a sentence to rather than an error code.
    const empty: MusicAnswer = { ok: true, kind: "results", results: [] };

    assert.deepEqual(empty.kind === "results" && empty.results, []);
  });
});
