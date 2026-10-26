import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoomSummary } from "@voxly/shared";
import { ChannelOrganizer } from "../src/components/shell/ChannelOrganizer.js";
import { OwnerServerContext } from "../src/features/owner/OwnerServerContext.js";
import { channelGroups, moveRoom, moveRoomBy, roomLayout } from "../src/lib/channelLayout.js";
import { translate } from "../src/lib/i18n.js";
const rooms: RoomSummary[] = ["text", "voice", "voice", "text", "voice"].map((kind, index) => ({
  id: `room${index}`,
  serverId: "server",
  name: `Channel ${index}`,
  kind: kind as "text" | "voice",
  categoryId: null,
  position: index * 10,
  isAfk: false
}));
const noop = async () => {};
it("renders one heading per uncategorized channel type after interleaved creation", () => {
  const html = renderToStaticMarkup(
    <ChannelOrganizer
      serverId="server"
      categories={[]}
      rooms={rooms}
      uncategorizedPosition={0}
      canManage={false}
      actionMenu={{ active: null, open() {}, close() {} }}
      t={(key, values) => translate("en", key, values)}
      onCreateCategory={noop}
      onRenameCategory={noop}
      onDeleteCategory={noop}
      onCreateRoom={noop}
      onSaveLayout={noop}
      renderRoom={(room) => <span>{room.name}</span>}
    />
  );
  assert.equal((html.match(/>Text channels</g) ?? []).length, 1);
  assert.equal((html.match(/>Voice channels</g) ?? []).length, 1);
  assert.ok(html.indexOf("Channel 3") < html.indexOf("Voice channels"));
  const groups = channelGroups([], rooms);
  assert.deepEqual(
    groups[0]?.rooms.map((room) => room.id),
    ["room0", "room3", "room1", "room2", "room4"]
  );
  assert.strictEqual(moveRoomBy(groups, "room1", -1), groups);
  assert.deepEqual(
    moveRoomBy(groups, "room3", -1)[0]?.rooms.map((room) => room.id),
    ["room3", "room0", "room1", "room2", "room4"]
  );
  const moved = moveRoom(groups, "room4", { categoryId: null, roomId: "room0" });
  assert.deepEqual(
    moved[0]?.rooms.map((room) => room.id),
    ["room0", "room3", "room4", "room1", "room2"]
  );
  assert.equal(new Set(roomLayout(moved).groups.flatMap((group) => group.roomIds)).size, rooms.length);
});
it("keeps existing-server controls outside the new-server section", () => {
  const html = renderToStaticMarkup(
    <OwnerServerContext
      activeServerId="server"
      servers={[
        {
          id: "server",
          name: "Basement",
          role: "owner",
          canInvite: true,
          afkTimeoutMinutes: 30,
          welcomeNotices: true,
          welcomeRoomId: null
        }
      ]}
      t={(key, values) => translate("en", key, values)}
      onCreate={noop}
      onRename={async () => {
        throw new Error("unused");
      }}
      onSetAfkTimeout={noop}
      textRooms={rooms.filter((room) => room.kind === "text")}
      onSetWelcome={noop}
      onRequestDelete={() => {}}
    />
  );
  const creation = html.slice(html.indexOf('class="owner-new-server"'));
  assert.match(creation, /Create a new server/);
  assert.doesNotMatch(creation, /ownerServerAfkTimeout|ownerServerRename|ownerServerWelcomeRoom|btn-danger/);
  assert.match(html, /Current server: Basement/);
});
it("offers the Welcome notice switch and every text channel, with the top channel as the default", () => {
  const render = (welcomeNotices: boolean, welcomeRoomId: string | null) =>
    renderToStaticMarkup(
      <OwnerServerContext
        activeServerId="server"
        servers={[
          {
            id: "server",
            name: "Basement",
            role: "owner",
            canInvite: true,
            afkTimeoutMinutes: 30,
            welcomeNotices,
            welcomeRoomId
          }
        ]}
        t={(key, values) => translate("tr", key, values)}
        onCreate={noop}
        onRename={async () => {
          throw new Error("unused");
        }}
        onSetAfkTimeout={noop}
        textRooms={rooms.filter((room) => room.kind === "text")}
        onSetWelcome={noop}
        onRequestDelete={() => {}}
      />
    );
  const on = render(true, null);
  const welcome = on.slice(
    on.indexOf('class="form-field owner-server-welcome"'),
    on.indexOf('class="owner-server-danger"')
  );
  assert.match(welcome, /<legend>Yeni üyelere hoş geldin de<\/legend>/);
  assert.match(welcome, /type="checkbox" checked=""/);
  assert.match(welcome, /<option value="" selected="">En üstteki metin kanalı<\/option>/);
  assert.match(welcome, /# Channel 0[\s\S]*# Channel 3/);
  assert.doesNotMatch(welcome, /Channel 1|Channel 2|Channel 4/);
  const off = render(false, "room3");
  assert.doesNotMatch(off, /type="checkbox" checked=""/);
  assert.match(off, /<select class="input" id="ownerServerWelcomeRoom" disabled="">/);
  assert.match(off, /<option value="room3" selected="">/);
});
