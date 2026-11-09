import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteComposer } from "../src/features/invites/InviteComposer.js";
import { OwnerInviteTable } from "../src/features/owner/OwnerInviteTable.js";
import { translate } from "../src/lib/i18n.js";
import type { OwnerInvite } from "../src/types.js";

const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);
const invite: OwnerInvite = {
  id: "11111111-2222-3333-4444-555555555555",
  serverId: "server",
  label: "Friends",
  createdByUserId: "owner",
  usedByUserId: null,
  usedAt: null,
  expiresAt: null,
  revokedAt: null,
  maxUses: 5,
  usedCount: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  createdBy: { userId: "owner", nickname: "Owner", mentionCode: "ABC123", state: "active" },
  uses: [],
  inactiveSince: null
};

describe("channels and invites on Permissions (ADR-0038, ticket 04)", () => {
  it("shows the Invite trail to the owner alone", () => {
    const owner = renderToStaticMarkup(
      <OwnerInviteTable invites={[invite]} language="en" timeFormat="auto" t={t} onRevoke={() => undefined} />
    );
    assert.match(owner, /invite-trail-toggle/);
    const manager = renderToStaticMarkup(
      <OwnerInviteTable
        invites={[{ ...invite, createdBy: null, createdByUserId: null }]}
        language="en"
        timeFormat="auto"
        t={t}
        onRevoke={() => undefined}
        showTrail={false}
      />
    );
    assert.doesNotMatch(manager, /invite-trail-toggle|invite-creator/);
    assert.match(manager, /Revoke/);
  });

  it("offers a link that never expires only with Manage invites", () => {
    const plain = renderToStaticMarkup(<InviteComposer serverId="s" publicUrl={null} idPrefix="a" t={t} />);
    assert.doesNotMatch(plain, /value="never"/);
    const manager = renderToStaticMarkup(
      <InviteComposer serverId="s" publicUrl={null} idPrefix="b" allowPermanent t={t} />
    );
    assert.match(manager, /value="never"/);
  });

  it("gates the rail's channel actions on Manage channels, not ownership", () => {
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
    assert.match(rail, /permissions\.includes\("manageChannels"\)/);
    assert.match(rail, /const\s+actionControl\s*=\s*canManageChannels\s*&&\s*room\.canEnter\s*\?/);
    assert.match(rail, /canManage=\{canManageChannels\}/);
  });
});
