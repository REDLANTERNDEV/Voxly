import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canInviteToActiveServer, memberRoleLabel } from "../src/app/presentation.js";
import { translate } from "../src/lib/i18n.js";
import type { ServerSummary } from "../src/types.js";

const servers: ServerSummary[] = [
  { id: "alpha", name: "Alpha", role: "owner", canInvite: true, afkTimeoutMinutes: 60 },
  { id: "beta", name: "Beta", role: "member", canInvite: true, afkTimeoutMinutes: 60 },
  { id: "gamma", name: "Gamma", role: "member", canInvite: false, afkTimeoutMinutes: 60 }
];

describe("delegated invite permission", () => {
  it("opens the invite affordance for owners and granted members only", () => {
    assert.equal(canInviteToActiveServer({ activeServerId: "alpha", servers }), true);
    assert.equal(canInviteToActiveServer({ activeServerId: "beta", servers }), true);
    assert.equal(canInviteToActiveServer({ activeServerId: "gamma", servers }), false);
    assert.equal(canInviteToActiveServer({ activeServerId: "missing", servers }), false);
  });

  it("ranks owner above the delegated invite role in member lists", () => {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate("en", key, values);

    assert.equal(memberRoleLabel({ role: "owner", canInvite: true }, t), "Owner");
    assert.equal(memberRoleLabel({ role: "member", canInvite: true }, t), "Inviter");
    assert.equal(memberRoleLabel({ role: "member", canInvite: false }, t), "User");
  });

  it("localizes the invite role controls in both supported languages", () => {
    assert.equal(translate("en", "member.grantInviteRole"), "Allow creating invites");
    assert.equal(translate("tr", "member.grantInviteRole"), "Davet oluşturma yetkisi ver");
    assert.equal(translate("tr", "member.revokeInviteRole"), "Davet yetkisini kaldır");
    assert.equal(translate("tr", "invite.createFor", { server: "Onyx" }), "Onyx sunucusuna kişi davet et");
  });

  it("puts the rail invite trigger beside the brand lockup and gates it on the grant", () => {
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(rail, /className="rail-head"/);
    assert.match(rail, /canInvite \? <InviteQuickAction/);
    assert.match(styles, /\.rail-head\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  });

  it("routes both invite surfaces through one composer", () => {
    const quickAction = readFileSync("src/features/invites/InviteQuickAction.tsx", "utf8");
    const ownerPanel = readFileSync("src/features/owner/OwnerPanel.tsx", "utf8");

    assert.match(quickAction, /<InviteComposer/);
    assert.match(ownerPanel, /<InviteComposer/);
    assert.doesNotMatch(ownerPanel, /createServerInvite/);
  });

  it("only offers the role toggle to owners acting on plain members", () => {
    const panel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");
    const menu = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");

    assert.match(panel, /const canAssignRoles = canModerate && user\.role === "member"/);
    assert.match(panel, /onToggleInviteRole=\{canAssignRoles \?/);
    assert.match(menu, /member\.grantInviteRole/);
    assert.match(menu, /member\.revokeInviteRole/);
  });
});
