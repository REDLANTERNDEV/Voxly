import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { serverPermissions, type PresenceUser, type RoleSummary } from "@voxly/shared";
import {
  RoleEditor,
  RolePermissionsTab,
  ServerRolesSection
} from "../src/features/serverSettings/ServerRolesSection.js";
import { translate } from "../src/lib/i18n.js";
import {
  canManageRole,
  clearedPermissions,
  dropRole,
  moveRole,
  roleMemberCount,
  type RoleActor
} from "../src/lib/roles.js";
import { serverSettingsSections } from "../src/lib/serverSettings.js";

const role = (id: string, position: number, extra: Partial<RoleSummary> = {}): RoleSummary => ({
  id,
  serverId: "server",
  name: id,
  color: null,
  position,
  separate: false,
  permissions: [],
  kind: null,
  ...extra
});
const roles = [
  role("admin", 4, { kind: "admin", name: null, permissions: ["administrator"] }),
  role("mods", 3, { color: "#2b7fd4" }),
  role("helpers", 2),
  role("fans", 1),
  role("everyone", 0, { kind: "everyone", name: null })
];
const owner: RoleActor = { role: "owner", permissions: [...serverPermissions], rank: 5 };
const admin: RoleActor = { role: "member", permissions: [...serverPermissions], rank: 4 };
const helperManager: RoleActor = { role: "member", permissions: ["manageRoles"], rank: 2 };
const members: PresenceUser[] = [
  { userId: "a", nickname: "Ada", role: "member", roleIds: ["helpers", "fans"] },
  { userId: "b", nickname: "Ece", role: "member", roleIds: ["fans"] },
  { userId: "o", nickname: "Owner", role: "owner", roleIds: [] },
  { userId: "m", nickname: "Music", role: "member", roleIds: [], isBot: true }
];
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);
const actions = {
  onCreateRole: async () => roles[1]!,
  onUpdateRole: async () => roles[1]!,
  onReorderRoles: async () => undefined,
  onDeleteRole: async () => undefined,
  onSetMemberRole: async () => members[0]!
};

describe("the Role editor (ADR-0038, decisions 5–7, 17 and 19)", () => {
  it("reaches the Roles section with Manage roles alone", () => {
    assert.deepEqual(serverSettingsSections({ role: "member", permissions: ["manageRoles"] }), ["roles", "members"]);
  });

  it("lets an Admin manage Roles below them but never Admin, and the owner everything", () => {
    assert.equal(canManageRole(admin, roles[0]!), false);
    assert.equal(canManageRole(admin, roles[1]!), true);
    assert.equal(canManageRole(owner, roles[0]!), true);
    assert.equal(canManageRole(helperManager, roles[2]!), false);
    assert.equal(canManageRole(helperManager, roles[3]!), true);
    assert.equal(canManageRole({ role: "member", permissions: [], rank: 4 }, roles[3]!), false);
  });

  it("moves Roles by keyboard the same as by dragging, and never a fixed Role", () => {
    assert.deepEqual(moveRole(admin, roles, "helpers", -1), ["helpers", "mods", "fans"]);
    assert.deepEqual(dropRole(admin, roles, "helpers", "mods"), ["helpers", "mods", "fans"]);
    assert.deepEqual(moveRole(admin, roles, "fans", -1), dropRole(admin, roles, "fans", "helpers"));
    assert.equal(moveRole(admin, roles, "mods", -1), null);
    assert.equal(moveRole(admin, roles, "fans", 1), null);
    assert.equal(moveRole(admin, roles, "admin", 1), null);
    // A Role at the actor's own rank does not move, nor anything past it.
    assert.equal(moveRole(helperManager, roles, "fans", -1), null);
    assert.equal(dropRole(helperManager, roles, "fans", "mods"), null);
  });

  it("counts people, not Bots, and everyone for @everyone", () => {
    assert.equal(roleMemberCount(roles[3]!, members), 2);
    assert.equal(roleMemberCount(roles[4]!, members), 3);
  });

  it("keeps Administrator on Admin and when anyone but the owner clears a Role", () => {
    assert.deepEqual(clearedPermissions(admin, roles[0]!), ["administrator"]);
    // Admin holds Administrator always, even when the owner clears it.
    assert.deepEqual(clearedPermissions(owner, roles[0]!), ["administrator"]);
    assert.deepEqual(clearedPermissions(owner, { ...roles[1]!, permissions: ["administrator"] }), []);
  });

  it("lists the Roles in rank order with counts, Create role, and arrows only where they work", () => {
    const html = renderToStaticMarkup(
      <ServerRolesSection actor={admin} roles={roles} members={members} t={t} onError={() => undefined} {...actions} />
    );
    assert.match(html, /Create role/);
    const names = [...html.matchAll(/class="server-roles-name">([^<]+)</g)].map((match) => match[1]);
    assert.deepEqual(names, ["Admin", "mods", "helpers", "fans", "@everyone"]);
    assert.match(html, /aria-label="Move mods up"[^>]*disabled=""|disabled=""[^>]*aria-label="Move mods up"/);
    assert.match(html, /<li data-role-row="mods" class="server-roles-row" draggable="true"/);
    assert.match(html, /2 members/);
  });

  it("locks Administrator for an Admin, shows @everyone only Permissions, and searches permissions", () => {
    const editor = (actor: RoleActor, target: RoleSummary) =>
      renderToStaticMarkup(
        <RoleEditor
          actor={actor}
          roles={roles}
          members={members}
          role={target}
          t={t}
          onSelect={() => undefined}
          onBack={() => undefined}
          onCreate={() => undefined}
          onFailed={() => undefined}
          {...actions}
        />
      );
    const everyone = editor(owner, roles[4]!);
    assert.equal(everyone.match(/role="tab"/g)?.length, 1);
    assert.match(everyone, /Every member holds @everyone/);
    assert.equal(everyone.match(/role="switch"/g)?.length, serverPermissions.length);

    const mods = editor(admin, roles[1]!);
    assert.equal(mods.match(/role="tab"/g)?.length, 3);
    assert.match(mods, /aria-label="Red"/);
    assert.match(mods, /role="radio" aria-checked="false" aria-label="No colour"/);

    // Manage roles alone hands down only what its holder has.
    const fans = renderToStaticMarkup(
      <RolePermissionsTab
        actor={helperManager}
        role={roles[3]!}
        t={t}
        editable
        onFailed={() => undefined}
        onUpdateRole={actions.onUpdateRole}
      />
    );
    assert.match(fans, /aria-label="Manage server"[^>]*disabled=""/);
    assert.match(fans, /You can only switch on permissions you hold\./);
    assert.doesNotMatch(fans, /aria-label="Manage roles"[^>]*disabled=""/);

    const adminRole = editor(admin, roles[0]!);
    assert.match(adminRole, /Only the owner can change this role\./);
  });

  it("speaks both languages for every Role editor and Permission string", () => {
    const keys = [
      "serverSettings.roles",
      "roles.create",
      "roles.tabDisplay",
      "roles.tabPermissions",
      "roles.tabMembers",
      "roles.separate",
      "roles.clearPermissions",
      "roles.limitReached",
      "roles.nameLength",
      "roles.notHeld",
      ...serverPermissions.map((permission) => `permission.${permission}` as const),
      ...serverPermissions.map((permission) => `permission.${permission}Hint` as const)
    ] as const;
    for (const key of keys) assert.notEqual(translate("tr", key), translate("en", key), key);
  });
});
