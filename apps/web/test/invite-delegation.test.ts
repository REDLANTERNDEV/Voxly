import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canInviteToActiveServer, memberRoleLabel } from "../src/app/presentation.js";
import { serverPermissions, type RoleSummary } from "@voxly/shared";
import { translate } from "../src/lib/i18n.js";
import type { ServerSummary } from "../src/types.js";

const servers: ServerSummary[] = [
  {
    id: "alpha",
    name: "Alpha",
    role: "owner",
    permissions: [...serverPermissions],
    rank: 3,
    afkTimeoutMinutes: 60,
    welcomeNotices: true,
    welcomeRoomId: null
  },
  {
    id: "beta",
    name: "Beta",
    role: "member",
    permissions: ["createInvites"],
    rank: 1,
    afkTimeoutMinutes: 60,
    welcomeNotices: true,
    welcomeRoomId: null
  },
  {
    id: "gamma",
    name: "Gamma",
    role: "member",
    permissions: [],
    rank: 0,
    afkTimeoutMinutes: 60,
    welcomeNotices: true,
    welcomeRoomId: null
  }
];

describe("the Create invites Permission (ADR-0038)", () => {
  it("opens the invite affordance for exactly the members holding Create invites", () => {
    assert.equal(canInviteToActiveServer({ activeServerId: "alpha", servers }), true);
    assert.equal(canInviteToActiveServer({ activeServerId: "beta", servers }), true);
    assert.equal(canInviteToActiveServer({ activeServerId: "gamma", servers }), false);
    assert.equal(canInviteToActiveServer({ activeServerId: "missing", servers }), false);
  });

  it("labels a member by owner, then their highest Role, then User", () => {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate("en", key, values);
    const roles: RoleSummary[] = [
      {
        id: "recruiter",
        serverId: "beta",
        name: null,
        color: null,
        position: 1,
        separate: false,
        permissions: ["createInvites"],
        kind: null
      }
    ];

    assert.equal(memberRoleLabel({ role: "owner", roleIds: ["recruiter"] }, t, roles), "Owner");
    assert.equal(memberRoleLabel({ role: "member", roleIds: ["recruiter"] }, t, roles), "Recruiter");
    assert.equal(memberRoleLabel({ role: "member", roleIds: [] }, t, roles), "User");
    assert.equal(memberRoleLabel({ role: "member", roleIds: [], isBot: true }, t, roles), "Bot");
  });

  it("localizes the invite copy in both supported languages", () => {
    assert.equal(translate("tr", "invite.createFor", { server: "Onyx" }), "Onyx sunucusuna kişi davet et");
  });

  it("puts the rail invite trigger beside the brand lockup and gates it on the Permission", () => {
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(rail, /className="rail-head"/);
    assert.match(rail, /canInvite\s+\?\s+\(?\s*<InviteQuickAction/);
    assert.match(styles, /\.rail-head\s*\{\s*[^}]*grid-template-columns:\s*minmax\(\s*0,\s+1fr\s*\)\s+auto/s);
  });

  it("routes both invite surfaces through one composer", () => {
    const quickAction = readFileSync("src/features/invites/InviteQuickAction.tsx", "utf8");
    const ownerPanel = readFileSync("src/features/owner/OwnerPanel.tsx", "utf8");

    assert.match(quickAction, /<InviteComposer/);
    assert.match(ownerPanel, /<InviteComposer/);
    assert.doesNotMatch(ownerPanel, /createServerInvite/);
  });

  it("has no per-member invite switch left anywhere", () => {
    for (const file of [
      "src/components/shell/MemberPanel.tsx",
      "src/components/shell/SidebarMenus.tsx",
      "src/features/owner/OwnerPanel.tsx"
    ]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /canInvite|onToggleInviteRole|grantInviteRole/, file);
    }
  });
});
