import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PresenceUser, RoleSummary, RoomSummary } from "@voxly/shared";
import { forceLeaveNoticeKey } from "../src/app/presentation.js";
import { ChannelAccessDialog } from "../src/features/owner/ChannelAccessDialog.js";
import { translate } from "../src/lib/i18n.js";
import { canMemberEnter } from "../src/lib/memberDirectory.js";

const room: RoomSummary = {
  id: "den",
  serverId: "server",
  name: "Den",
  kind: "text",
  position: 0,
  categoryId: null,
  isAfk: false,
  isPrivate: true,
  listed: false,
  canEnter: true,
  accessUserIds: ["insider"]
};
const owner: PresenceUser = { userId: "owner", nickname: "Owner", role: "owner" };
const insider: PresenceUser = { userId: "insider", nickname: "Insider", role: "member" };
const outsider: PresenceUser = { userId: "outsider", nickname: "Outsider", role: "member" };
const bot: PresenceUser = { userId: "bot", nickname: "Music", role: "member", isBot: true };
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("private channels (ADR-0037)", () => {
  it("offers a private channel only to owners and its Channel access", () => {
    assert.equal(canMemberEnter(room, owner), true);
    assert.equal(canMemberEnter(room, insider), true);
    assert.equal(canMemberEnter(room, outsider), false);
    assert.equal(canMemberEnter({ ...room, isPrivate: false, accessUserIds: undefined }, outsider), true);
    assert.equal(canMemberEnter({ ...room, accessUserIds: undefined }, insider), false);
  });

  it("explains a lost voice channel in both languages", () => {
    const key = forceLeaveNoticeKey("room_access_revoked");
    assert.equal(key, "voiceNotice.channelAccessRevoked");
    assert.notEqual(translate("en", key), translate("tr", key));
  });

  it("shows owners locked on, leaves Bots out, and checks the current list", () => {
    const html = renderToStaticMarkup(
      <ChannelAccessDialog
        room={room}
        members={[owner, insider, outsider, bot]}
        lockedReason={null}
        returnFocus={null}
        t={t}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />
    );
    assert.match(html, /role="dialog"/);
    assert.match(html, /Access to Den/);
    assert.match(html, /Owner, always has access/);
    assert.doesNotMatch(html, /Music/);
    const checked = [...html.matchAll(/<input type="checkbox"([^>]*)>/g)].map((match) => match[1]!);
    // The Private switch, then Owner (locked), Insider (on), Outsider (off).
    assert.equal(checked.length, 4);
    assert.match(checked[1]!, /checked=""/);
    assert.match(checked[1]!, /disabled=""/);
    assert.match(checked[2]!, /checked=""/);
    assert.doesNotMatch(checked[3]!, /checked/);
  });

  it("refuses to make the AFK or Welcome channel private, and says why", () => {
    const html = renderToStaticMarkup(
      <ChannelAccessDialog
        room={{ ...room, isPrivate: false, accessUserIds: undefined }}
        members={[owner]}
        lockedReason={t("channel.accessAfkLocked")}
        returnFocus={null}
        t={t}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />
    );
    assert.match(html, /role="switch"[^>]*disabled=""/);
    assert.match(html, /The AFK channel can&#x27;t be private\./);
  });

  it("marks a private row with a lock a screen reader hears, and never enters a Listed one without access", () => {
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
    assert.match(
      rail,
      /<LockIcon\s*\/>\s*<span\s+className="sr-only">\s*\{\s*t\(\s*"channel\.private"\s*\)\s*\}\s*<\/span>/
    );
    assert.match(
      rail,
      /disabledReason=\{\s*room\.canEnter\s*\?\s*undefined\s*:\s*props\.t\(\s*"channel\.noAccessVoice"\s*\)\s*\}/
    );
    assert.match(rail, /if\s*\(\s*props\.socketState\s*!==\s*"live"\s*\|\|\s*!room\.canEnter\s*\)\s*return;/);
    assert.match(rail, /const\s+showCallLength\s*=\s*callStart\s*!==\s*undefined\s*&&\s*room\.canEnter;/);
    assert.match(rail, /\{\s*member\.media\.screen\s*&&\s*room\.canEnter\s*\?/);
    const screen = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
    assert.match(screen, /const\s+readOnly\s*=\s*props\.currentRoom\s*\?\s*!props\.currentRoom\.canEnter\s*:\s*false;/);
    assert.match(screen, /\{\s*readOnly\s*\?\s*null\s*:\s*\(\s*<form\s+onSubmit=\{\s*submit\s*\}>/);
  });
});

describe("Roles on Channel access (ADR-0038, ticket 07)", () => {
  const roles: RoleSummary[] = [
    {
      id: "admins",
      serverId: "server",
      name: "Admins",
      color: null,
      position: 2,
      separate: false,
      permissions: ["administrator"],
      kind: null
    },
    {
      id: "crew",
      serverId: "server",
      name: "Crew",
      color: null,
      position: 1,
      separate: false,
      permissions: [],
      kind: null
    },
    {
      id: "everyone",
      serverId: "server",
      name: null,
      color: null,
      position: 0,
      separate: false,
      permissions: [],
      kind: "everyone"
    }
  ];
  const crewRoom: RoomSummary = { ...room, accessUserIds: [], accessRoleIds: ["crew"] };

  it("lets in a member through a Role on the access, or through Administrator", () => {
    assert.equal(canMemberEnter(crewRoom, { ...outsider, roleIds: ["crew"] }, roles), true);
    assert.equal(canMemberEnter(crewRoom, { ...outsider, roleIds: [] }, roles), false);
    assert.equal(canMemberEnter(crewRoom, { ...outsider, roleIds: ["admins"] }, roles), true);
    // A Bot is never let in by a Role.
    assert.equal(canMemberEnter(crewRoom, { ...bot, roleIds: ["crew"] }, roles), false);
  });

  it("lists Roles above members, @everyone left out and Administrator locked on", () => {
    const html = renderToStaticMarkup(
      <ChannelAccessDialog
        room={crewRoom}
        members={[owner, insider]}
        roles={roles}
        lockedReason={null}
        returnFocus={null}
        t={t}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />
    );
    assert.ok(html.indexOf("channel-access-roles") < html.indexOf("Insider"), "Roles come before members");
    assert.match(html, /Administrator, always has access/);
    assert.doesNotMatch(html, /@everyone/);
    assert.match(html, /checked=""[^>]*\/><span class="channel-access-name">Crew/);
    assert.notEqual(translate("tr", "channel.accessRoles"), translate("en", "channel.accessRoles"));
  });
});

describe("Channel access while creating a channel", () => {
  it("starts public with only the switch, and opens the lists once it is private", async () => {
    const { ChannelAccessFields, channelAccessDraft, channelAccessUpdate } =
      await import("../src/features/owner/ChannelAccessDialog.js");
    const props = {
      onChange: () => undefined,
      members: [owner, insider],
      lockedReason: null,
      privateLocked: false,
      disabled: false,
      idPrefix: "channelCreateAccess",
      t
    };
    const closed = renderToStaticMarkup(<ChannelAccessFields draft={channelAccessDraft()} {...props} />);
    assert.match(closed, /role="switch"/);
    assert.doesNotMatch(closed, /Insider/);
    const draft = { ...channelAccessDraft(), isPrivate: true, userIds: new Set(["owner", "insider"]) };
    const open = renderToStaticMarkup(<ChannelAccessFields draft={draft} {...props} />);
    assert.match(open, /name="channelCreateAccessVisibility"/);
    assert.match(open, /Insider/);
    // Owners always have access, so they are never sent on the list.
    assert.deepEqual(channelAccessUpdate(draft, [owner, insider]), {
      isPrivate: true,
      listed: false,
      userIds: ["insider"],
      roleIds: []
    });
    assert.notEqual(translate("tr", "organizer.accessCopy"), translate("en", "organizer.accessCopy"));
  });

  it("keeps a confirmation's focus where the member put it, above the phone drawer", () => {
    const dialogs = readFileSync("src/components/ui/Dialogs.tsx", "utf8");
    const confirm = dialogs.slice(
      dialogs.indexOf("export function ConfirmDialog"),
      dialogs.indexOf("export function NicknameDialog")
    );
    // Focus moves once per opening, never again on a parent's re-render.
    assert.match(confirm, /\(confirmationRef\.current \?\? cancelRef\.current\)\?\.focus\(\);\s*\},\s*\[\]\);/);
    assert.doesNotMatch(confirm, /\[onCancel\]\)/);
    assert.match(confirm, /<ModalPortal>/);
  });
});

describe("the member panel of a private channel", () => {
  it("lists only those with access, and the whole Server elsewhere", async () => {
    const { channelAudience } = await import("../src/lib/memberDirectory.js");
    const everyone = [owner, insider, outsider];
    const names = (list: readonly PresenceUser[]) => list.map((member) => member.nickname);
    assert.deepEqual(names(channelAudience(room, everyone)), ["Owner", "Insider"]);
    assert.deepEqual(names(channelAudience({ ...room, isPrivate: false }, everyone)), ["Owner", "Insider", "Outsider"]);
    assert.deepEqual(names(channelAudience(undefined, everyone)), ["Owner", "Insider", "Outsider"]);
    // A Listed channel the viewer only reads carries no access list to narrow by.
    assert.deepEqual(names(channelAudience({ ...room, canEnter: false, accessUserIds: undefined }, everyone)), [
      "Owner",
      "Insider",
      "Outsider"
    ]);
    // A Role on the access lets its members in.
    const crew = { ...outsider, roleIds: ["crew"] };
    assert.deepEqual(names(channelAudience({ ...room, accessRoleIds: ["crew"] }, [owner, crew])), [
      "Owner",
      "Outsider"
    ]);
  });
});
