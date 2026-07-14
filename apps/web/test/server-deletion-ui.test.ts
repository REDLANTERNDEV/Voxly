import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("server and channel deletion UI", () => {
  it("requires exact-name confirmation for destructive channel and server actions", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const switcher = readFileSync("src/components/ServerSwitcher.tsx", "utf8");

    assert.match(app, /confirmationText\?: string/);
    assert.match(app, /confirmationValue === confirmationText/);
    assert.match(app, /onDeleteRoom/);
    assert.match(switcher, /onRequestDelete/);
    assert.match(switcher, /deleteDisabled/);
  });

  it("refreshes navigation for realtime room and server deletion events", () => {
    const app = readFileSync("src/App.tsx", "utf8");

    assert.match(app, /socket\.on\("server:roomsChanged"/);
    assert.match(app, /socket\.on\("server:deleted"/);
    assert.match(app, /deletedRoomId/);
  });
});
