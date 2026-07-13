import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RoomSummary } from "@voxly/shared";
import {
  clearUnread,
  incrementUnread,
  readRoomHistory,
  rememberRoom,
  resolveRememberedRoom,
  unreadAfterMessage,
  writeRoomHistory
} from "../src/lib/channelState.js";

const textRoom: RoomSummary = { id: "general", serverId: "alpha", name: "General", kind: "text", position: 10 };
const voiceRoom: RoomSummary = { id: "lobby", serverId: "alpha", name: "Lobby", kind: "voice", position: 20 };

describe("channel state", () => {
  it("remembers the last room independently by server and kind", () => {
    const history = rememberRoom({}, "alpha", "text", "general");
    const withVoice = rememberRoom(history, "alpha", "voice", "lobby");
    const withOtherServer = rememberRoom(withVoice, "beta", "text", "news");

    assert.deepEqual(withOtherServer, {
      alpha: { text: "general", voice: "lobby" },
      beta: { text: "news" }
    });
    assert.deepEqual(history, { alpha: { text: "general" } });
  });

  it("uses a remembered room only while it still exists", () => {
    assert.equal(resolveRememberedRoom([textRoom, voiceRoom], "lobby"), voiceRoom);
    assert.equal(resolveRememberedRoom([textRoom, voiceRoom], "missing"), textRoom);
    assert.equal(resolveRememberedRoom([], "missing"), null);
  });

  it("increments unread messages immutably and clears a room when opened", () => {
    const initial = { general: 2 };
    const incremented = incrementUnread(initial, "news");

    assert.deepEqual(incremented, { general: 2, news: 1 });
    assert.deepEqual(initial, { general: 2 });
    assert.deepEqual(clearUnread(incremented, "general"), { news: 1 });
    assert.equal(clearUnread(incremented, "missing"), incremented);
  });

  it("counts only another user's messages outside the active text room", () => {
    const unread = { general: 2 };

    assert.deepEqual(unreadAfterMessage(unread, { roomId: "news", userId: "other" }, "general", "me"), {
      general: 2,
      news: 1
    });
    assert.equal(unreadAfterMessage(unread, { roomId: "general", userId: "other" }, "general", "me"), unread);
    assert.equal(unreadAfterMessage(unread, { roomId: "news", userId: "me" }, "general", "me"), unread);
  });

  it("persists versioned history and ignores malformed storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const history = { alpha: { text: "general", voice: "lobby" } };

    writeRoomHistory(storage, history);
    assert.deepEqual(readRoomHistory(storage), history);

    values.set("voxly:room-history:v1", "not-json");
    assert.deepEqual(readRoomHistory(storage), {});
  });
});
