import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CategorySummary, RoomSummary } from "@voxly/shared";
import { channelGroups, moveGroup, moveGroupBy, moveRoom, moveRoomBy, roomLayout } from "../src/lib/channelLayout.js";

function category(id: string, position: number): CategorySummary {
  return { id, serverId: "server", name: id, position };
}

function room(id: string, kind: "text" | "voice", categoryId: string | null, position: number): RoomSummary {
  return { id, serverId: "server", name: id, kind, categoryId, position, isAfk: false };
}

describe("server channel layout", () => {
  it("orders uncategorized and named groups by their shared position", () => {
    const groups = channelGroups(
      [category("later", 20), category("empty", 10)],
      [room("voice", "voice", "later", 10), room("text", "text", "later", 20), room("loose", "text", null, 30)],
      30
    );

    assert.deepEqual(groups.map((group) => [group.category?.id ?? null, group.rooms.map((item) => item.id)]), [
      ["empty", []],
      ["later", ["voice", "text"]],
      [null, ["loose"]]
    ]);
  });

  it("moves a room into an empty category and inserts it around another room", () => {
    const groups = channelGroups([category("one", 10), category("two", 20)], [
      room("a", "text", "one", 10), room("b", "voice", null, 20), room("c", "voice", "two", 30)
    ]);

    const intoEmpty = moveRoom(groups, "b", { categoryId: "one" });
    assert.deepEqual(intoEmpty[1].rooms.map((item) => item.id), ["a", "b"]);
    assert.equal(intoEmpty[0].rooms.length, 0);
    const before = moveRoom(intoEmpty, "c", { categoryId: "one", roomId: "a" });
    assert.deepEqual(before[1].rooms.map((item) => item.id), ["c", "a", "b"]);
    assert.equal(before[1].rooms[0]?.categoryId, "one");
  });

  it("reorders all groups, including Uncategorized, and rooms for accessible move controls", () => {
    const groups = channelGroups([category("one", 10), category("two", 20)], [
      room("a", "text", "one", 10), room("b", "voice", "one", 20), room("c", "text", "two", 30)
    ]);

    assert.deepEqual(moveGroup(groups, "two", "one").map((group) => group.category?.id ?? null), [null, "two", "one"]);
    assert.deepEqual(moveGroupBy(groups, "two", -1).map((group) => group.category?.id ?? null), [null, "two", "one"]);
    assert.deepEqual(moveGroupBy(groups, null, 1).map((group) => group.category?.id ?? null), ["one", null, "two"]);
    assert.deepEqual(moveRoomBy(groups, "b", -1)[1].rooms.map((item) => item.id), ["b", "a"]);
  });

  it("serializes empty categories and each room exactly once", () => {
    const groups = channelGroups([category("one", 10), category("empty", 20)], [room("a", "voice", "one", 10)]);
    assert.deepEqual(roomLayout(groups), {
      groups: [
        { categoryId: null, roomIds: [] },
        { categoryId: "one", roomIds: ["a"] },
        { categoryId: "empty", roomIds: [] }
      ]
    });
  });
});
