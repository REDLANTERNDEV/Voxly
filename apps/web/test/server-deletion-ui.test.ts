import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("server and channel deletion UI", () => {
  it("keeps the shared server switcher focused on navigation", () => {
    const app = readAppSource();
    const switcher = readFileSync("src/components/ServerSwitcher.tsx", "utf8");
    const channelRail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";

    assert.match(switcher, /id="serverSelect"/);
    assert.doesNotMatch(switcher, /server-create-control/);
    assert.doesNotMatch(switcher, /onCreate/);
    assert.doesNotMatch(switcher, /onRequestDelete/);
    assert.doesNotMatch(channelRail, /onCreate=\{props\.onCreateServer\}/);
    assert.doesNotMatch(channelRail, /onRequestDelete=/);
  });

  it("places server lifecycle actions in the owner server context", () => {
    const app = readAppSource();
    const ownerPanel = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(ownerPanel, /className="owner-server-context"/);
    assert.match(ownerPanel, /function OwnerServerContext/);
    assert.match(ownerPanel, /encodeURIComponent\(serverId\)[\s\S]*?\/owner/);
    assert.match(ownerPanel, /props\.onCreateServer/);
    assert.match(ownerPanel, /props\.onUpdateServerName/);
    assert.match(ownerPanel, /onRename=\{props\.onUpdateServerName\}/);
    assert.match(ownerPanel, /props\.onDeleteServer/);
    assert.doesNotMatch(ownerPanel, /InviteTargetSelector/);
  });

  it("requires exact-name confirmation for destructive channel and server actions", () => {
    const app = readAppSource();

    assert.match(app, /confirmationText\?: string/);
    assert.match(app, /confirmationValue === confirmationText/);
    assert.match(app, /onDeleteRoom/);
    assert.match(app, /onDeleteServer/);
    assert.match(app, /last_owner_server/);
  });

  it("refreshes navigation for realtime room and server deletion events", () => {
    const app = readAppSource();

    assert.match(app, /next\.on\("server:roomsChanged"/);
    assert.match(app, /next\.on\("server:deleted"/);
    assert.match(app, /deletedRoomId/);
  });

  it("treats a room-list change without a deleted id as a plain refresh", () => {
    // Channel creation reuses this event, so the handler must not assume a
    // deletion and must leave the reader where they are.
    const workspace = readFileSync("src/app/useWorkspaceController.ts", "utf8");
    const realtime = readFileSync("src/app/useRealtimeSync.ts", "utf8");

    assert.match(workspace, /refreshRooms = useCallback\(async \(serverId: string, deletedRoomId\?: string\)/);
    assert.match(realtime, /roomsChanged\(serverId: string, deletedRoomId: string \| undefined\)/);
    assert.match(workspace, /currentRoute\.roomId === deletedRoomId/);
  });
});
