import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe,it } from "node:test";
import { remainingDeletionCooldownHours } from "../src/lib/accountDeletion.js";

describe("account deletion request cooldown", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");

  it("reports the rounded-up wait after cancellation or rejection", () => {
    assert.equal(remainingDeletionCooldownHours({ status: "cancelled", resolvedAt: "2026-09-21T11:30:00.000Z" }, now), 24);
    assert.equal(remainingDeletionCooldownHours({ status: "rejected", resolvedAt: "2026-09-20T13:30:00.000Z" }, now), 2);
  });

  it("shows no wait for pending, approved, expired, or malformed decisions", () => {
    assert.equal(remainingDeletionCooldownHours({ status: "pending", resolvedAt: null }, now), null);
    assert.equal(remainingDeletionCooldownHours({ status: "approved", resolvedAt: "2026-09-21T11:00:00.000Z" }, now), null);
    assert.equal(remainingDeletionCooldownHours({ status: "cancelled", resolvedAt: "2026-09-20T12:00:00.000Z" }, now), null);
    assert.equal(remainingDeletionCooldownHours({ status: "rejected", resolvedAt: "not-a-date" }, now), null);
  });
});

describe("owner account deletion confirmation", () => {
  it("clears both confirmations whenever the dialog is closed", () => {
    const source = readFileSync("src/features/owner/OwnerAccountSections.tsx", "utf8");

    assert.match(source, /function closeDeleteDialog\(\)[\s\S]*setConfirmation\(""\)[\s\S]*setPermanent\(false\)/);
    assert.match(source, /onClick=\{closeDeleteDialog\}/);
  });
});
