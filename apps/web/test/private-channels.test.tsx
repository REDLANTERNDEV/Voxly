import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PresenceUser, RoomSummary } from "@voxly/shared";
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
