import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { serverPermissions, type PresenceUser, type RoleSummary } from "@voxly/shared";
import { canInviteToActiveServer } from "../src/app/presentation.js";
import { MemberRoleRow, MemberRolesSubmenu } from "../src/components/shell/SidebarMenus.js";
import { translate } from "../src/lib/i18n.js";
import { memberRank, memberRoleRows, roleDisplayName, type RoleActor } from "../src/lib/roles.js";

const role = (id: string, position: number, extra: Partial<RoleSummary> = {}): RoleSummary => ({
  id,
  serverId: "server",
  name: null,
  color: null,
  position,
  separate: false,
  permissions: [],
  kind: null,
  ...extra
});
const roles = [
  role("admin", 3, { kind: "admin", permissions: ["administrator"] }),
  role("recruiter", 2, { permissions: ["createInvites"] }),
  role("helper", 1, { name: "Helper", color: "#2b7fd4" }),
  role("everyone", 0, { kind: "everyone" })
];
const owner: RoleActor = { role: "owner", permissions: [...serverPermissions], rank: 4 };
const admin: RoleActor = { role: "member", permissions: [...serverPermissions], rank: 3 };
const recruiterManager: RoleActor = { role: "member", permissions: ["createInvites", "manageRoles"], rank: 2 };
const plain: RoleActor = { role: "member", permissions: [], rank: 0 };
const member = (roleIds: string[], extra: Partial<PresenceUser> = {}): PresenceUser => ({
  userId: "target",
  nickname: "Ada",
  role: "member",
  roleIds,
  ...extra
});
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("Roles (ADR-0038)", () => {
  it("names a seeded Role in the reader's language and a named one as named", () => {
    assert.equal(roleDisplayName(roles[0]!, t), "Admin");
    assert.equal(roleDisplayName(roles[1]!, t), "Recruiter");
    assert.equal(
      roleDisplayName(roles[1]!, (key) => translate("tr", key)),
      "Davetçi"
    );
    assert.equal(roleDisplayName(roles[2]!, t), "Helper");
    assert.equal(roleDisplayName(roles[3]!, t), "@everyone");
  });

  it("ranks a member by their highest Role", () => {
    assert.equal(memberRank(roles, member([])), 0);
    assert.equal(memberRank(roles, member(["helper", "recruiter"])), 2);
  });

  it("offers the owner every Role but @everyone", () => {
    const rows = memberRoleRows(owner, roles, member(["recruiter"]))!;
    assert.deepEqual(
      rows.map((row) => [row.role.id, row.held, row.lock]),
      [
        ["admin", false, null],
        ["recruiter", true, null],
        ["helper", false, null],
        ["everyone", true, "everyone"]
      ]
    );
  });

  it("locks Admin for an Admin and every Role at or above the actor's rank", () => {
    assert.deepEqual(
      memberRoleRows(admin, roles, member([]))!.map((row) => row.lock),
      ["ownerOnly", null, null, "everyone"]
    );
    assert.deepEqual(
      memberRoleRows(recruiterManager, roles, member([]))!.map((row) => row.lock),
      ["ownerOnly", "belowYours", null, "everyone"]
    );
  });

  it("is absent for the owner, a Bot, an equal or higher rank, and without Manage roles", () => {
    assert.equal(memberRoleRows(owner, roles, member([], { role: "owner" })), null);
    assert.equal(memberRoleRows(owner, roles, member([], { isBot: true })), null);
    assert.equal(memberRoleRows(admin, roles, member(["admin"])), null);
    assert.equal(memberRoleRows(recruiterManager, roles, member(["recruiter"])), null);
    assert.equal(memberRoleRows(plain, roles, member([])), null);
    assert.equal(memberRoleRows(undefined, roles, member([])), null);
    // Nothing left to toggle: only @everyone and locked Roles below it.
    assert.equal(memberRoleRows({ role: "member", permissions: ["manageRoles"], rank: 1 }, roles, member([])), null);
  });

  it("lets Create invites decide the invite affordance", () => {
    const servers = [
      { id: "a", role: "member" as const, permissions: ["createInvites" as const] },
      { id: "b", role: "member" as const, permissions: [] }
    ];
    assert.equal(canInviteToActiveServer({ activeServerId: "a", servers }), true);
    assert.equal(canInviteToActiveServer({ activeServerId: "b", servers }), false);
    assert.equal(canInviteToActiveServer({ activeServerId: "missing", servers }), false);
  });

  it("renders the submenu as checkbox rows with a colour dot, and locked rows say why", () => {
    const html = renderToStaticMarkup(
      <MemberRolesSubmenu
        nickname="Ada"
        rows={memberRoleRows(admin, roles, member(["recruiter"]))!}
        onToggle={() => undefined}
        t={t}
      />
    );
    assert.match(html, /Roles/);
    // The flyout itself is portalled and only opens on hover, arrow or tap;
    // its rows are pinned through the row component below.
    const rows = renderToStaticMarkup(
      <>
        {memberRoleRows(admin, roles, member(["recruiter"]))!.map((row) => (
          <MemberRoleRow key={row.role.id} row={row} onToggle={() => undefined} t={t} />
        ))}
      </>
    );
    assert.equal(rows.match(/role="menuitemcheckbox"/g)?.length, 4);
    assert.match(rows, /aria-checked="true"[^>]*>.*Recruiter/);
    assert.match(rows, /aria-disabled="true"[^>]*title="Only the owner can give this role"/);
    assert.match(rows, /title="Everyone has this role"/);
    assert.match(rows, /style="--role-color:#2b7fd4"/);
  });

  it("keeps the submenu open across toggles and opens it from the arrow key", () => {
    const menus = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");
    const rolesBlock = menus.slice(menus.indexOf("export function MemberRolesSubmenu"));
    // A toggle never closes the menu: the row calls onToggle and nothing else.
    assert.doesNotMatch(rolesBlock, /actionMenu\.close|setOpen\(false\)/);
    const submenu = readFileSync("src/components/MenuSubmenu.tsx", "utf8");
    assert.match(submenu, /event\.key !== "ArrowRight"/);
  });

  it("speaks both languages for every Roles string", () => {
    for (const key of [
      "member.roles",
      "member.rolesFor",
      "role.everyone",
      "role.admin",
      "role.recruiter",
      "role.lockEveryone",
      "role.lockOwnerOnly",
      "role.lockBelowYours"
    ] as const) {
      assert.notEqual(translate("tr", key, { nickname: "Ada" }), key);
      assert.notEqual(translate("en", key, { nickname: "Ada" }), key);
    }
  });
});
