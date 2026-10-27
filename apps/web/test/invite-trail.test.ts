import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daysUntilRemoval, partitionInvites, trailPersonName } from "../src/lib/inviteTrail.js";
import { translate } from "../src/lib/i18n.js";
import type { InviteUse, OwnerInvite } from "../src/types.js";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-27T12:00:00.000Z");

function invite(overrides: Partial<OwnerInvite> = {}): OwnerInvite {
  return {
    id: "invite",
    serverId: "server",
    label: "Friends",
    createdByUserId: "owner",
    usedByUserId: null,
    usedAt: null,
    expiresAt: null,
    revokedAt: null,
    maxUses: 1,
    usedCount: 0,
    createdAt: new Date(now - 40 * day).toISOString(),
    createdBy: { userId: "owner", nickname: "Owner", mentionCode: "1234", state: "active" },
    uses: [],
    inactiveSince: null,
    ...overrides
  };
}

const use: InviteUse = { userId: "ada", nickname: "Ada", mentionCode: "0042", state: "active", joinedAt: "x" };

describe("the Invite trail in the owner panel", () => {
  it("keeps active invites in the main list and moves the rest into the past group", () => {
    const live = invite({ id: "live" });
    const past = invite({ id: "past", inactiveSince: new Date(now - day).toISOString() });

    const { active, past: pastList } = partitionInvites([live, past]);

    assert.deepEqual(
      active.map((item) => item.id),
      ["live"]
    );
    assert.deepEqual(
      pastList.map((item) => item.id),
      ["past"]
    );
  });

  it("counts the days an unused past invite has left, and none for one somebody used", () => {
    assert.equal(daysUntilRemoval(invite(), now), null, "an active invite is not being removed");
    assert.equal(daysUntilRemoval(invite({ inactiveSince: new Date(now - day).toISOString() }), now), 29);
    assert.equal(daysUntilRemoval(invite({ inactiveSince: new Date(now - 30 * day).toISOString() }), now), 0);
    assert.equal(
      daysUntilRemoval(invite({ inactiveSince: new Date(now - 29 * day).toISOString(), uses: [use] }), now),
      null,
      "a used invite is the trail and is kept"
    );
  });

  it("names a person by nickname and Mention code, and a deleted one only as Deleted member", () => {
    const en = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate("en", key, values);
    const tr = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate("tr", key, values);

    assert.equal(trailPersonName(use, en), "Ada #0042");
    const deleted = { ...use, nickname: null, mentionCode: null, state: "deleted" as const };
    assert.equal(trailPersonName(deleted, en), "Deleted member");
    assert.equal(trailPersonName(deleted, tr), "Silinmiş üye");
  });
});
