import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { auditLogActions, type AuditLogEntry } from "@voxly/shared";
import { auditRoleChanges, auditSentence } from "../src/lib/auditLog.js";
import { translate } from "../src/lib/i18n.js";
import { serverSettingsSections } from "../src/lib/serverSettings.js";

const ada = { userId: "ada", nickname: "Ada", isBot: false };
const bo = { userId: "bo", nickname: "Bo", isBot: false };

function entry(action: AuditLogEntry["action"], details: AuditLogEntry["details"] = {}, target = bo): AuditLogEntry {
  return { id: action, action, createdAt: "2026-11-13T10:00:00.000Z", actor: ada, target, details };
}

const text = (value: AuditLogEntry, language: "en" | "tr" = "en") =>
  auditSentence(value, (key, values) => translate(language, key, values))
    .map((part) => part.text)
    .join("");

describe("Audit log lines (ADR-0039)", () => {
  it("reads every action as a whole sentence in both languages", () => {
    for (const language of ["en", "tr"] as const) {
      for (const action of auditLogActions) {
        const line = text(entry(action, { name: "x", room: "general", roomKind: "text" }), language);
        assert.doesNotMatch(line, /[{}]/, `${language} ${action}: ${line}`);
        assert.match(line, /Ada/);
      }
    }
  });

  it("draws names in bold and the words between them plain", () => {
    const parts = auditSentence(entry("room.created", { room: "news", roomKind: "text" }), (key, values) =>
      translate("en", key, values)
    );
    assert.deepEqual(
      parts.filter((part) => part.strong).map((part) => part.text),
      ["Ada", "#news"]
    );
  });

  it("names a channel the reader may not see only as a private channel", () => {
    assert.equal(
      text(entry("message.deleted", { roomHidden: true, roomKind: "text" })),
      "Ada deleted a message by Bo in a private channel"
    );
  });

  it("says what a line recorded: renames, own nicknames and seeded Roles", () => {
    assert.equal(
      text(entry("room.renamed", { room: "news", previousRoom: "announcements", roomKind: "text" })),
      "Ada renamed #announcements to #news"
    );
    assert.equal(text(entry("member.nickname_updated", { name: "Ace" }, ada)), "Ada changed their nickname to Ace");
    assert.equal(text(entry("role.given", { name: null, roleKind: "admin" })), "Ada gave Bo the role Admin");
    assert.equal(
      text({ ...entry("invite.created", { name: "Friends" }, bo), actor: null, target: null }),
      "Someone created the invite Friends"
    );
  });

  it("lists the Permissions a Role edit added and removed", () => {
    const lines = auditRoleChanges(
      entry("role.updated", {
        name: "Mods",
        changes: ["permissions"],
        added: ["viewAuditLog"],
        removed: ["manageInvites"]
      }),
      (key, values) => translate("en", key, values),
      (permission) => translate("en", `permission.${permission}`)
    );
    assert.deepEqual(lines, ["Permissions added: View audit log", "Permissions removed: Manage invites"]);
  });

  it("is a section only for View audit log, which Administrator includes", () => {
    assert.deepEqual(serverSettingsSections({ role: "member", permissions: ["viewAuditLog"] }), ["auditLog"]);
    assert.ok(!serverSettingsSections({ role: "member", permissions: ["manageServer"] }).includes("auditLog"));
    const window = readFileSync("src/features/serverSettings/ServerSettingsWindow.tsx", "utf8");
    assert.match(window, /section === "auditLog" \? \(\s*<ServerAuditLogSection/);
  });
});
