import type { RoomSummary } from "@voxly/shared";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_AFK_TIMEOUT_MINUTES } from "@voxly/shared";
import {
  afkActivityEvents,
  afkIdleCheckIntervalMs,
  afkTimeoutFor,
  afkTimeoutMs,
  afkRoomIdFor,
  indexAfkRoom,
  shouldMoveToAfk
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
  it("parks a member only once the full window has elapsed", () => {
    const base = { activeVoiceRoomId: "lobby", afkRoomId: "afk-s1", timeoutMinutes: DEFAULT_AFK_TIMEOUT_MINUTES };
    const window = afkTimeoutMs(DEFAULT_AFK_TIMEOUT_MINUTES);

    assert.equal(shouldMoveToAfk({ ...base, lastActivityAt: 0, now: window - 1 }), false);
    assert.equal(shouldMoveToAfk({ ...base, lastActivityAt: 0, now: window }), true);
  });

  it("defaults to an hour and honours the owner's choice instead when set", () => {
    assert.equal(DEFAULT_AFK_TIMEOUT_MINUTES, 60);
    const base = { activeVoiceRoomId: "lobby", afkRoomId: "afk-s1", lastActivityAt: 0 };

    assert.equal(shouldMoveToAfk({ ...base, timeoutMinutes: 15, now: afkTimeoutMs(15) }), true);
    assert.equal(shouldMoveToAfk({ ...base, timeoutMinutes: 240, now: afkTimeoutMs(15) }), false);
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

  it("leaves a member who is not in voice alone", () => {
    // Joining voice on someone's behalf is an action they never asked for.
    assert.equal(shouldMoveToAfk({
      lastActivityAt: 0,
      now: afkTimeoutMs(DEFAULT_AFK_TIMEOUT_MINUTES) * 5,
      activeVoiceRoomId: null,
      afkRoomId: "afk-s1",
      timeoutMinutes: DEFAULT_AFK_TIMEOUT_MINUTES
    }), false);
  });

  it("does not move a member who is already in the AFK room", () => {
    assert.equal(shouldMoveToAfk({
      lastActivityAt: 0,
      now: afkTimeoutMs(DEFAULT_AFK_TIMEOUT_MINUTES) * 5,
      activeVoiceRoomId: "afk-s1",
      afkRoomId: "afk-s1",
      timeoutMinutes: DEFAULT_AFK_TIMEOUT_MINUTES
    }), false);
  });

  it("stays put when the server has no AFK room, rather than guessing one", () => {
    // An owner may delete it like any other room.
    assert.equal(shouldMoveToAfk({
      lastActivityAt: 0,
      now: afkTimeoutMs(DEFAULT_AFK_TIMEOUT_MINUTES) * 5,
      activeVoiceRoomId: "lobby",
      afkRoomId: null,
      timeoutMinutes: DEFAULT_AFK_TIMEOUT_MINUTES
    }), false);
  });
});

describe("AFK room resolution", () => {
  const roomServerIds = { general: "s1", lobby: "s1", "afk-s1": "s1", "other-lobby": "s2", "afk-s2": "s2" };
  const afkRoomIdsByServer = { s1: "afk-s1", s2: "afk-s2" };

  it("picks the AFK room of the server the member is actually in", () => {
    assert.equal(afkRoomIdFor(roomServerIds, afkRoomIdsByServer, "lobby"), "afk-s1");
    assert.equal(afkRoomIdFor(roomServerIds, afkRoomIdsByServer, "other-lobby"), "afk-s2");
  });

  it("resolves across servers, since voice outlives navigation", () => {
    // The member is connected to s2 while browsing s1; the active server's room
    // list would not contain their voice room at all.
    assert.equal(afkRoomIdFor(roomServerIds, afkRoomIdsByServer, "other-lobby"), "afk-s2");
  });

  it("resolves nothing without a current voice room or for an unknown one", () => {
    assert.equal(afkRoomIdFor(roomServerIds, afkRoomIdsByServer, null), null);
    assert.equal(afkRoomIdFor(roomServerIds, afkRoomIdsByServer, "missing"), null);
  });

  it("resolves nothing for a server with no AFK room", () => {
    assert.equal(afkRoomIdFor({ lonely: "s3" }, afkRoomIdsByServer, "lonely"), null);
  });
});

describe("AFK room indexing", () => {
  it("records one server's AFK voice room", () => {
    const index: Record<string, string> = {};

    indexAfkRoom(index, "s1", rooms);

    assert.deepEqual(index, { s1: "afk-s1" });
  });

  it("clears the entry when the room is gone, rather than leaving a stale target", () => {
    const index: Record<string, string> = { s1: "afk-s1" };

    indexAfkRoom(index, "s1", rooms.filter((room) => !room.isAfk));

    assert.deepEqual(index, {});
  });

  it("ignores a flagged text room and another server's AFK room", () => {
    const index: Record<string, string> = {};

    indexAfkRoom(index, "s1", [{ ...room("general", "s1", true), kind: "text" as const }, room("afk-s2", "s2", true)]);

    assert.deepEqual(index, {});
  });
});

describe("activity sources", () => {
  it("counts pointer, keyboard, wheel, and touch interaction", () => {
    assert.deepEqual([...afkActivityEvents], ["pointerdown", "keydown", "wheel", "touchstart"]);
  });

  it("checks often enough to land the move within a minute of the deadline", () => {
    assert.ok(afkIdleCheckIntervalMs <= 60_000);
    // Shorter than the shortest timeout an owner can choose.
    assert.ok(afkIdleCheckIntervalMs < afkTimeoutMs(15));
  });

  it("treats speaking as presence, so a long talker is never parked", () => {
    const hook = readFileSync("src/app/useIdleAfk.ts", "utf8");

    assert.match(hook, /if \(!speaking\) return;\s*\n\s*lastActivityAtRef\.current = Date\.now\(\);/);
    // Speaking also clears an already-published away state, not just the clock.
    assert.match(hook, /lastActivityAtRef\.current = Date\.now\(\);\s*\n\s*publishStatus\("online"\);/);
  });

  it("listens in the capture phase so a stopped event cannot fake absence", () => {
    const hook = readFileSync("src/app/useIdleAfk.ts", "utf8");

    assert.match(hook, /addEventListener\(event, markActive, \{ capture: true, passive: true \}\)/);
    assert.match(hook, /removeEventListener\(event, markActive, \{ capture: true \}\)/);
  });

  it("does not retry a failed move every tick", () => {
    const hook = readFileSync("src/app/useIdleAfk.ts", "utf8");

    assert.match(hook, /if \(movingRef\.current\) return;/);
    assert.match(hook, /lastActivityAtRef\.current = Date\.now\(\);\s*\n\s*void joinVoiceRef\.current/);
  });

  it("moves through an ordinary voice join, adding no server authority", () => {
    const app = readFileSync("src/App.tsx", "utf8");

    assert.match(app, /joinVoice: \(roomId: string\) => audio\.voice\.join\(roomId, \[\], \{\}\)/);
  });
});

describe("away status reporting", () => {
  const hook = readFileSync("src/app/useIdleAfk.ts", "utf8");

  it("reports away independently of any move, so a text-only member still shows idle", () => {
    // The move needs a voice room; the directory dot does not.
    assert.match(hook, /publishStatus\(Date\.now\(\) - lastActivityAtRef\.current >= afkTimeoutMs\(timeoutMinutes\) \? "idle" : "online"\)/);
  });

  it("sends only transitions, so the socket is not used as a heartbeat", () => {
    assert.match(hook, /if \(reportedStatusRef\.current === status\) return;/);
  });

  it("clears the away state on the first interaction", () => {
    assert.match(hook, /const markActive = \(\) => \{[\s\S]*?publishStatus\("online"\);/);
  });
});
