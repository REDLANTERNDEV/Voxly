import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { remainingDeletionCooldownHours } from "../src/lib/accountDeletion.js";

describe("account deletion request cooldown", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");

  it("reports the rounded-up wait after cancellation or rejection", () => {
    assert.equal(
      remainingDeletionCooldownHours({ status: "cancelled", resolvedAt: "2026-09-21T11:30:00.000Z" }, now),
      24
    );
    assert.equal(
      remainingDeletionCooldownHours({ status: "rejected", resolvedAt: "2026-09-20T13:30:00.000Z" }, now),
      2
    );
  });

  it("shows no wait for pending, approved, expired, or malformed decisions", () => {
    assert.equal(remainingDeletionCooldownHours({ status: "pending", resolvedAt: null }, now), null);
    assert.equal(
      remainingDeletionCooldownHours({ status: "approved", resolvedAt: "2026-09-21T11:00:00.000Z" }, now),
      null
    );
    assert.equal(
      remainingDeletionCooldownHours({ status: "cancelled", resolvedAt: "2026-09-20T12:00:00.000Z" }, now),
      null
    );
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

describe("owner deletion request presentation", () => {
  const source = readFileSync("src/features/owner/OwnerAccountSections.tsx", "utf8");
  const section = source.slice(
    source.indexOf("export function OwnerDeletionRequestsSection"),
    source.indexOf("export function OwnerAccountsSection")
  );
  const css = readFileSync("src/visual-refresh.css", "utf8");

  it("lays a request out as its own card rather than borrowing chat message actions", () => {
    assert.doesNotMatch(section, /message-actions/);
    assert.match(section, /className="owner-deletion-actions"/);
    assert.match(section, /owner-accounts-panel/);
  });

  it("does not claim there are no requests before the first load answers", () => {
    assert.match(section, /useState<OwnerDeletionRequest\[\] \| null>\(null\)/);
    assert.match(section, /requests === null \?/);
  });

  it("locks a request's decisions while one is in flight", () => {
    assert.match(section, /setPendingId\(current\.request\.id\)/);
    assert.match(section, /\.finally\(\(\) => setPendingId\(null\)\)/);
    assert.equal(section.match(/disabled=\{pendingId === request\.id\}/g)?.length, 2);
  });

  it("confirms a rejection with a neutral button, since it destroys nothing", () => {
    assert.match(section, /tone=\{decision\.kind === "approve" \? "danger" : "neutral"\}/);
  });

  it("gives phone-width decisions full-width 44px targets", () => {
    const narrow = css.slice(css.indexOf(".owner-deletion-actions {"));
    assert.match(
      narrow,
      /@media \(max-width: 720px\)[\s\S]*?\.owner-deletion-actions \.btn\s*\{[^}]*min-height:\s*44px/
    );
  });
});
