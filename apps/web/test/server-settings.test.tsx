import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { serverPermissions, type Permission } from "@voxly/shared";
import { ServerSettingsWindow } from "../src/features/serverSettings/ServerSettingsWindow.js";
import { translate } from "../src/lib/i18n.js";
import { serverMenuItems, serverSettingsSections } from "../src/lib/serverSettings.js";
import type { ServerSummary } from "../src/types.js";

const owner = { role: "owner" as const, permissions: [...serverPermissions] };
const admin = { role: "member" as const, permissions: [...serverPermissions] };
const recruiter = { role: "member" as const, permissions: ["createInvites"] as Permission[] };
const plain = { role: "member" as const, permissions: [] as Permission[] };
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("en", key, values);
const noop = async () => undefined;

function summary(standing: { role: "owner" | "member"; permissions: Permission[] }): ServerSummary {
  return {
    id: "server",
    name: "Basement",
    ...standing,
    rank: 2,
    afkTimeoutMinutes: 30,
    welcomeNotices: true,
    welcomeRoomId: null
  };
}

function renderWindow(server: ServerSummary) {
  return renderToStaticMarkup(
    <ServerSettingsWindow
      user={{ id: "me", nickname: "Me", role: "member", bannedAt: null }}
      servers={[server]}
      serverRoles={[]}
      serverMembers={[]}
      activeServerId="server"
      rooms={{ text: [], voice: [] }}
      appConfig={{ clientVersion: null, publicUrl: null, turnstile: null, analytics: null } as never}
      language="en"
      timeFormat="auto"
      t={t}
      onUpdateServerName={async () => server}
      onSetAfkTimeout={noop}
      onSetWelcome={noop}
      onDeleteServer={noop}
      onModerateMember={noop}
      onVoiceModeration={async () => ({ moderation: { muted: false, deafened: false } })}
      onUpdateMemberNickname={async () => ({ userId: "x", nickname: "x", role: "member" })}
      onCreateRole={async () => {
        throw new Error("unused");
      }}
      onUpdateRole={async () => {
        throw new Error("unused");
      }}
      onReorderRoles={noop}
      onDeleteRole={noop}
      onSetMemberRole={async () => ({ userId: "x", nickname: "x", role: "member" })}
      onClose={() => undefined}
    />
  );
}

describe("Server settings (ADR-0038, decisions 14–16 and 20)", () => {
  it("lists only the sections a member's Permissions reach", () => {
    assert.deepEqual(serverSettingsSections(owner), [
      "overview",
      "roles",
      "members",
      "inviteTrail",
      "accessLinks",
      "deleteServer"
    ]);
    // An Admin runs the Server but never the owner's own three.
    assert.deepEqual(serverSettingsSections(admin), ["overview", "roles"]);
    assert.deepEqual(serverSettingsSections({ role: "member", permissions: ["manageServer"] }), ["overview"]);
    assert.deepEqual(serverSettingsSections(recruiter), []);
    assert.deepEqual(serverSettingsSections(plain), []);
    assert.deepEqual(serverSettingsSections(undefined), []);
  });

  it("offers the server menu's items by Permission, and no settings entry with no section", () => {
    assert.deepEqual(serverMenuItems(owner), ["settings", "invite", "createChannel", "createCategory"]);
    assert.deepEqual(serverMenuItems(admin), ["settings", "invite"]);
    assert.deepEqual(serverMenuItems(recruiter), ["invite"]);
    assert.deepEqual(serverMenuItems(plain), []);
  });

  it("renders the window with its sections and the owner's under their own heading", () => {
    const html = renderWindow(summary(owner));
    assert.match(html, /role="dialog" aria-modal="true" aria-label="Server settings for Basement"/);
    for (const label of ["Overview", "Roles", "Members", "Invite trail", "Access links", "Delete server"]) {
      assert.match(html, new RegExp(`<span>${label}</span>`));
    }
    assert.match(html, /Owner only/);
    assert.match(html, /aria-current="true"[^>]*><span class="settings-nav-icon"[^>]*>[\s\S]*?<span>Overview<\/span>/);
    // The phone's way back is in the markup and named; CSS shows it under 900px.
    assert.match(html, /class="icon-btn server-settings-back"[\s\S]*?Back to sections/);
  });

  it("shows an Admin only Overview, and nothing at all to a member without a section", () => {
    const html = renderWindow(summary(admin));
    assert.match(html, /<span>Overview<\/span>/);
    assert.doesNotMatch(html, /Invite trail|Access links|Delete server|Owner only/);
    assert.equal(renderWindow(summary(recruiter)), "");
  });

  it("speaks both languages for every Server settings string", () => {
    for (const key of [
      "serverSettings.title",
      "serverSettings.overview",
      "serverSettings.members",
      "serverSettings.inviteTrail",
      "serverSettings.accessLinks",
      "serverSettings.deleteServer",
      "serverSettings.ownerHeading",
      "serverSettings.back",
      "serverMenu.invite",
      "serverMenu.createChannel",
      "serverMenu.createCategory"
    ] as const) {
      assert.notEqual(translate("tr", key), translate("en", key), key);
    }
  });

  it("opens the same menu from the server name and the server icon", () => {
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
    const workspace = readFileSync("src/components/shell/WorkspaceRail.tsx", "utf8");
    assert.match(rail, /const key = `server-menu:\$\{props\.activeServerId\}`/);
    assert.match(workspace, /const menuKey = `server-menu:\$\{server\.id\}`/);
    assert.match(workspace, /serverMenuItems\(server\)/);
  });

  it("leaves the owner panel with installation sections only, and no Target server picker", () => {
    const panel = readFileSync("src/features/owner/OwnerPanel.tsx", "utf8");
    assert.match(panel, /"overview" \| "deletionRequests" \| "accounts"/);
    assert.doesNotMatch(panel, /dashServerSelect|targetServer|fetchServerOwnerData/);
  });
});
