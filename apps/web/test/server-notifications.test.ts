import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerNotificationState } from "@voxly/shared";
import {
  canMarkRoomRead,
  serverNotificationsMuted,
  serverUnreadCount,
  unreadBadge,
  unreadRooms
} from "../src/lib/serverNotifications.js";

describe("Server notification presentation", () => {
  const state: ServerNotificationState = {
    serverId: "a",
    mute: { mode: "enabled" },
    rooms: [
      { roomId: "a1", unreadCount: 8, lastReadSequence: 1, latestSequence: 9 },
      { roomId: "a2", unreadCount: 3, lastReadSequence: 0, latestSequence: 3 }
    ]
  };
  it("aggregates and caps only the visible badge", () => {
    assert.equal(serverUnreadCount(state), 11);
    assert.equal(unreadBadge(11), "9+");
    assert.equal(unreadBadge(9), "9");
  });
  it("hides a muted Server badge while retaining channel counts and restores at expiry", () => {
    const muted = { ...state, mute: { mode: "until" as const, until: "2026-01-01T00:00:00Z" } };
    assert.equal(serverUnreadCount(muted, Date.parse(muted.mute.until) - 1), 0);
    assert.equal(serverUnreadCount(muted, Date.parse(muted.mute.until)), 11);
    assert.deepEqual(unreadRooms({ serverTime: "now", servers: [muted] }), { a1: 8, a2: 3 });
    assert.equal(serverNotificationsMuted({ ...state, mute: { mode: "indefinite" } }), true);
  });
  it("does not mark background or failed histories as read", () => {
    for (const input of [
      { loaded: false, visible: true, focused: true },
      { loaded: true, visible: false, focused: true },
      { loaded: true, visible: true, focused: false }
    ])
      assert.equal(canMarkRoomRead(input), false);
    assert.equal(canMarkRoomRead({ loaded: true, visible: true, focused: true }), true);
  });
});
