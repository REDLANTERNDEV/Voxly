/**
 * Which parts of a Server's settings a member may reach (ADR-0038, design
 * decisions 14 and 15).
 *
 * Every answer reads the `permissions` the server reported on the member's
 * `ServerSummary`; nothing here works a Permission out from Roles. The server
 * re-checks every action regardless, so this decides only what to offer.
 */

import { memberSettingsPermissions, type Permission } from "@voxly/shared";

export interface ServerStanding {
  role: "owner" | "member";
  permissions: readonly Permission[];
}

export type ServerSettingsSection =
  "overview" | "roles" | "members" | "invites" | "bans" | "auditLog" | "inviteTrail" | "accessLinks" | "deleteServer";

/** In the order the window lists them. */
const sectionRules: ReadonlyArray<{
  id: ServerSettingsSection;
  reaches: (server: ServerStanding) => boolean;
  ownerOnly?: true;
}> = [
  { id: "overview", reaches: (server) => server.permissions.includes("manageServer") },
  { id: "roles", reaches: (server) => server.permissions.includes("manageRoles") },
  {
    id: "members",
    reaches: (server) => memberSettingsPermissions.some((item) => server.permissions.includes(item))
  },
  { id: "invites", reaches: (server) => server.permissions.includes("manageInvites") },
  { id: "bans", reaches: (server) => server.permissions.includes("manageMembers") },
  { id: "auditLog", reaches: (server) => server.permissions.includes("viewAuditLog") },
  // These three stay with the owner for good (decision 10).
  { id: "inviteTrail", reaches: (server) => server.role === "owner", ownerOnly: true },
  { id: "accessLinks", reaches: (server) => server.role === "owner", ownerOnly: true },
  { id: "deleteServer", reaches: (server) => server.role === "owner", ownerOnly: true }
];

/** The sections this member may open, in order. Empty means no Server settings at all. */
export function serverSettingsSections(server: ServerStanding | undefined): ServerSettingsSection[] {
  if (!server) return [];
  return sectionRules.filter((rule) => rule.reaches(server)).map((rule) => rule.id);
}

/** Whether a section is one of the owner's own, listed under its own heading. */
export function isOwnerOnlySection(section: ServerSettingsSection) {
  return Boolean(sectionRules.find((rule) => rule.id === section)?.ownerOnly);
}

export type ServerMenuItem = "settings" | "invite" | "createChannel" | "createCategory";

/**
 * The server name menu's own items, each only for a member whose Permissions
 * reach it.
 */
export function serverMenuItems(server: ServerStanding | undefined): ServerMenuItem[] {
  if (!server) return [];
  const items: ServerMenuItem[] = [];
  if (serverSettingsSections(server).length > 0) items.push("settings");
  if (server.permissions.includes("createInvites")) items.push("invite");
  if (server.permissions.includes("manageChannels")) {
    items.push("createChannel", "createCategory");
  }
  return items;
}

/** The server menu's height before it is measured: its own items, then the notification rows. */
export function serverMenuHeight(itemCount: number) {
  return 100 + itemCount * 40;
}
