import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("server and channel deletion UI", () => {
  it("keeps the shared server switcher focused on navigation", () => {
    const app = readAppSource();
    const switcher = readFileSync("src/components/ServerSwitcher.tsx", "utf8");
    const channelRail = app.match(/function\s+ChannelRail[\s\S]*?\n}\n\nfunction\s+ChannelDeleteControl/)?.[0] ?? "";

    assert.match(switcher, /id="serverSelect"/);
    assert.doesNotMatch(switcher, /server-create-control/);
    assert.doesNotMatch(switcher, /onCreate/);
    assert.doesNotMatch(switcher, /onRequestDelete/);
    assert.doesNotMatch(channelRail, /onCreate=\{\s*props\.onCreateServer\s*\}/);
    assert.doesNotMatch(channelRail, /onRequestDelete=/);
  });

  it("places one Server's lifecycle in Server settings and new Servers in the owner panel", () => {
    const ownerPanel = readFileSync("src/features/owner/OwnerPanel.tsx", "utf8");
    const window = readFileSync("src/features/serverSettings/ServerSettingsWindow.tsx", "utf8");

    assert.match(ownerPanel, /<CreateServerSection/);
    assert.match(ownerPanel, /props\.onCreateServer/);
    assert.doesNotMatch(ownerPanel, /dashServerSelect|owner\.targetServer|onDeleteServer|onUpdateServerName/);
    assert.match(window, /onRename=\{\s*props\.onUpdateServerName\s*\}/);
    assert.match(window, /props\s*\.onDeleteServer\(\)/);
    assert.match(window, /confirmationText=\{\s*server\.name\s*\}/);
    assert.doesNotMatch(ownerPanel, /InviteTargetSelector/);
  });

  it("requires exact-name confirmation for destructive channel and server actions", () => {
    const app = readAppSource();

    assert.match(app, /confirmationText\?:\s+string/);
    assert.match(app, /confirmationValue\s+===\s+confirmationText/);
    assert.match(app, /onDeleteRoom/);
    assert.match(app, /onDeleteServer/);
    assert.match(app, /last_owner_server/);
  });

  it("refreshes navigation for realtime room and server deletion events", () => {
    const app = readAppSource();

    assert.match(app, /next\.on\(\s*"server:roomsChanged"/);
    assert.match(app, /next\.on\(\s*"server:deleted"/);
    assert.match(app, /deletedRoomId/);
  });

  it("treats a room-list change without a deleted id as a plain refresh", () => {
    // Channel creation reuses this event, so the handler must not assume a
    // deletion and must leave the reader where they are.
    const workspace = readFileSync("src/app/useWorkspaceController.ts", "utf8");
    const realtime = readFileSync("src/app/useRealtimeSync.ts", "utf8");

    assert.match(
      workspace,
      /refreshRooms\s+=\s+useCallback\(\s*async\s+\(\s*serverId:\s+string,\s+deletedRoomId\?:\s+string\s*\)/
    );
    assert.match(realtime, /roomsChanged\(\s*serverId:\s+string,\s+deletedRoomId:\s+string\s+\|\s+undefined\s*\)/);
    assert.match(workspace, /currentRoute\.roomId\s+===\s+deletedRoomId/);
  });
});
