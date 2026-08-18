import { DEFAULT_AFK_TIMEOUT_MINUTES } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import type { RoomSummary } from "@voxly/shared";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  afkActivityEvents,
  afkIdleCheckIntervalMs,
  afkTimeoutFor,
  afkTimeoutMs,
  indexAfkRoom
} from "../src/lib/idleActivity.js";

function room(id: string, serverId: string, isAfk = false): RoomSummary {
  return { id, serverId, name: id, kind: "voice", position: 10, isAfk };
}

const rooms = [
  { ...room("general", "s1"), kind: "text" as const },
  room("lobby", "s1"),
  room("afk-s1", "s1", true),
  room("other-lobby", "s2"),
  room("afk-s2", "s2", true)
];

describe("idle threshold", () => {
  it("defaults to an hour", () => {
    assert.equal(DEFAULT_AFK_TIMEOUT_MINUTES, 60);
    assert.equal(afkTimeoutMs(60), 60 * 60 * 1000);
  });

  it("measures against the server whose voice room the member is in", () => {
    // Voice outlives navigation, so the setting cannot come from whichever
    // server the member happens to be looking at.
    const roomServerIds = { lobby: "s1", "other-lobby": "s2" };
    const timeouts = { s1: 15, s2: 240 } as const;

    assert.equal(afkTimeoutFor(roomServerIds, timeouts, "lobby"), 15);
    assert.equal(afkTimeoutFor(roomServerIds, timeouts, "other-lobby"), 240);
    assert.equal(afkTimeoutFor(roomServerIds, timeouts, null), DEFAULT_AFK_TIMEOUT_MINUTES);
    assert.equal(afkTimeoutFor(roomServerIds, timeouts, "unknown"), DEFAULT_AFK_TIMEOUT_MINUTES);
  });

  it("checks often enough to turn the dot within a minute of the deadline", () => {
    assert.ok(afkIdleCheckIntervalMs <= 60_000);
    // Shorter than the shortest timeout an owner can choose.
    assert.ok(afkIdleCheckIntervalMs < afkTimeoutMs(15));
  });
});

describe("idle presence", () => {
  it("marks the member and never moves them", () => {
    // A browser sees only its own window, so a muted player in a fullscreen
    // game produces exactly the signal of someone who left. Acting on that
    // guess pulls a present member out of the conversation and mutes them;
    // showing it costs a dot. Only the dot is justified.
    const hook = readFileSync("src/app/useIdlePresence.ts", "utf8");

    assert.match(hook, /reportStatusRef\.current\(status\)/);
    assert.doesNotMatch(hook, /joinVoice|shouldMoveToAfk|afkRoomId/);
  });

  it("reports only transitions, so the socket is not a heartbeat", () => {
    const hook = readFileSync("src/app/useIdlePresence.ts", "utf8");

    assert.match(hook, /if \(reportedStatusRef\.current === status\) return;/);
  });

  it("counts interaction and speech alike as presence", () => {
    const hook = readFileSync("src/app/useIdlePresence.ts", "utf8");

    assert.deepEqual([...afkActivityEvents], ["pointerdown", "keydown", "wheel", "touchstart"]);
    // Capture phase: a handler that stops propagation must not make the person
    // look absent.
    assert.match(hook, /\{ capture: true, passive: true \}/);
    assert.match(hook, /if \(!speaking\) return;[\s\S]*?publishStatus\("online"\)/);
  });
});

describe("idle setting copy", () => {
  it("describes what the setting does now, not what it used to do", () => {
    // The threshold once triggered a move. Copy that still promises one would
    // have an owner configuring a consequence that no longer exists.
    // The label must not promise a move. The hint may mention one, but only to
    // deny it, so it is pinned positively rather than by absence.
    assert.doesNotMatch(translate("en", "owner.afkTimeout"), /Move to/i);
    assert.doesNotMatch(translate("tr", "owner.afkTimeout"), /taşıma/i);
    assert.match(translate("en", "owner.afkTimeoutHint"), /Nobody is moved or muted/);
    assert.match(translate("tr", "owner.afkTimeoutHint"), /Kimse taşınmaz veya susturulmaz/);
  });

  it("names all three presence states in both languages", () => {
    for (const key of ["presence.online", "presence.idle", "presence.offline"] as const) {
      assert.ok(translate("en", key).length > 0);
      assert.ok(translate("tr", key).length > 0);
    }
    assert.equal(translate("tr", "presence.idle"), "Boşta");
  });
});

describe("AFK room index", () => {
  it("resolves each server's AFK room independently", () => {
    const index: Record<string, string> = {};
    indexAfkRoom(index, "s1", rooms);
    indexAfkRoom(index, "s2", rooms);

    assert.deepEqual(index, { s1: "afk-s1", s2: "afk-s2" });
  });

  it("clears the entry when the room is gone, leaving nothing to key the mute off", () => {
    const index: Record<string, string> = { s1: "afk-s1" };

    indexAfkRoom(index, "s1", rooms.filter((item) => item.id !== "afk-s1"));

    assert.deepEqual(index, {});
  });

  it("ignores a text room that happens to carry the flag", () => {
    const index: Record<string, string> = {};

    indexAfkRoom(index, "s1", [{ ...room("odd", "s1", true), kind: "text" as const }]);

    assert.deepEqual(index, {});
  });
});
