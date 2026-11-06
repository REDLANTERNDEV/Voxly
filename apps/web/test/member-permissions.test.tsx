import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { serverPermissions, type PresenceUser, type RoleSummary } from "@voxly/shared";
import { ServerMembersSection } from "../src/features/serverSettings/ServerMembersSection.js";
import { translate } from "../src/lib/i18n.js";
import {
  canModeratePerson,
  canMovePerson,
  canRenameMember,
  canVoiceModerate,
  type ModerationActor
} from "../src/lib/memberDirectory.js";
import type { ServerMember } from "../src/types.js";

const roles: RoleSummary[] = [
  {
    id: "admin",
    serverId: "s",
    name: null,
    color: null,
    position: 2,
    separate: false,
    permissions: ["administrator"],
    kind: "admin"
  },
  { id: "mods", serverId: "s", name: "Mods", color: null, position: 1, separate: false, permissions: [], kind: null },
  {
    id: "everyone",
    serverId: "s",
    name: null,
    color: null,
    position: 0,
    separate: false,
    permissions: [],
    kind: "everyone"
  }
];
const admin: ModerationActor = { role: "member", permissions: [...serverPermissions], rank: 2, userId: "a1" };
const voiceMod: ModerationActor = { role: "member", permissions: ["voiceModeration"], rank: 1, userId: "v" };
const otherAdmin: PresenceUser = { userId: "a2", nickname: "Other", role: "member", roleIds: ["admin"] };
const plain: PresenceUser = { userId: "p", nickname: "Plain", role: "member", roleIds: [] };
const bot: PresenceUser = { userId: "b", nickname: "Music", role: "member", roleIds: [], isBot: true };
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("members, voice and messages on Permissions (ADR-0038, ticket 05)", () => {
  it("offers each action only where the server would accept it, rank included", () => {
    for (const check of [canVoiceModerate, canModeratePerson, canMovePerson, canRenameMember]) {
      assert.equal(check(admin, roles, otherAdmin), false, check.name);
      assert.equal(check(admin, roles, plain), true, check.name);
    }
    assert.equal(canVoiceModerate(voiceMod, roles, plain), true);
    assert.equal(canMovePerson(voiceMod, roles, plain), true);
    assert.equal(canModeratePerson(voiceMod, roles, plain), false);
    assert.equal(canRenameMember(voiceMod, roles, plain), false);
    // A Bot keeps voice moderation and never gets the person actions.
    assert.equal(canVoiceModerate(admin, roles, bot), true);
    assert.equal(canModeratePerson(admin, roles, bot), false);
    assert.equal(canMovePerson(admin, roles, bot), false);
    // Your own name stays yours without any Permission.
    assert.equal(canRenameMember(voiceMod, roles, { ...plain, userId: "v" }), true);
  });

  it("lists active members with a Roles column, and the banned under Bans", () => {
    const users: ServerMember[] = [
      {
        id: "p",
        nickname: "Plain",
        role: "member",
        roleIds: ["mods"],
        isBot: false,
        bannedAt: null,
        removedAt: null,
        joinedAt: "2026-01-01T00:00:00.000Z",
        moderation: { muted: false, deafened: false }
      },
      {
        id: "x",
        nickname: "Gone",
        role: "member",
        roleIds: [],
        isBot: false,
        bannedAt: "2026-02-01T00:00:00.000Z",
        removedAt: null,
        joinedAt: "2026-01-01T00:00:00.000Z",
        moderation: { muted: false, deafened: false }
      }
    ];
    const render = (mode: "members" | "bans") =>
      renderToStaticMarkup(
        <ServerMembersSection
          actor={admin}
          mode={mode}
          users={users}
          serverRoles={roles}
          t={t}
          onChanged={async () => undefined}
          onUsersChange={() => undefined}
          onError={() => undefined}
          onModerateMember={async () => undefined}
          onVoiceModeration={async () => ({ moderation: { muted: false, deafened: false } })}
          onUpdateMemberNickname={async () => plain}
          onSetMemberRole={async () => plain}
        />
      );
    const members = render("members");
    assert.match(members, /Plain/);
    assert.doesNotMatch(members, /Gone/);
    assert.match(members, /<span class="dash-role">Mods<\/span>/);
    const bans = render("bans");
    assert.match(bans, /Gone/);
    assert.doesNotMatch(bans, /Plain/);
    assert.match(bans, /1 banned\./);
  });

  it("gates message moderation on Manage messages rather than ownership", () => {
    const routes = readFileSync("src/app/AppRoutes.tsx", "utf8");
    assert.match(routes, /permissions\.includes\("manageMessages"\)/);
  });

  it("speaks both languages for the new section strings", () => {
    for (const key of ["serverSettings.bans", "serverSettings.rolesColumn"] as const) {
      assert.notEqual(translate("tr", key), translate("en", key), key);
    }
    assert.notEqual(
      translate("tr", "serverSettings.bannedCount", { count: 2 }),
      translate("en", "serverSettings.bannedCount", { count: 2 })
    );
  });
});
