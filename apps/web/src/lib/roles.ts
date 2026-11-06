/**
 * What a Server's Roles look like from one member's seat (ADR-0038).
 *
 * The server decides every Permission and rank and sends the answers on the
 * `ServerSummary`; nothing here works a Permission out from Roles. These
 * helpers only decide what to *offer*: which Role rows a member menu shows,
 * ticked or locked and why. The server re-checks each change regardless.
 */

import type { Permission, PresenceUser, RoleSummary } from "@voxly/shared";

/** The actor's own standing in the Server, as the server reported it. */
export interface RoleActor {
  role: "owner" | "member";
  permissions: readonly Permission[];
  rank: number;
}

/** Why a Role row cannot be toggled. */
export type RoleLock = "everyone" | "ownerOnly" | "belowYours";

export interface RoleMenuRow {
  role: RoleSummary;
  held: boolean;
  lock: RoleLock | null;
}

export function holdsPermission(actor: Pick<RoleActor, "permissions"> | undefined, permission: Permission) {
  return Boolean(actor?.permissions.includes(permission));
}

/** The position of a member's highest Role; `@everyone` alone is 0. */
export function memberRank(roles: readonly RoleSummary[], member: Pick<PresenceUser, "roleIds">) {
  const held = new Set(member.roleIds ?? []);
  return Math.max(0, ...roles.filter((role) => held.has(role.id)).map((role) => role.position));
}

/**
 * The rows of a member's Roles submenu, or null when the submenu should not
 * appear at all: the actor cannot manage Roles, the target is an owner or a
 * Bot, the target is not strictly below the actor, or every row is locked.
 */
export function memberRoleRows(
  actor: RoleActor | undefined,
  roles: readonly RoleSummary[],
  target: Pick<PresenceUser, "role" | "isBot" | "roleIds">
): RoleMenuRow[] | null {
  if (!actor || !holdsPermission(actor, "manageRoles")) return null;
  if (target.role === "owner" || target.isBot) return null;
  const isOwner = actor.role === "owner";
  if (!isOwner && memberRank(roles, target) >= actor.rank) return null;
  const held = new Set(target.roleIds ?? []);
  const rows = roles.map((role): RoleMenuRow => {
    if (role.kind === "everyone") return { role, held: true, lock: "everyone" };
    const lock: RoleLock | null = isOwner
      ? null
      : role.kind === "admin"
        ? "ownerOnly"
        : role.position >= actor.rank
          ? "belowYours"
          : null;
    return { role, held: held.has(role.id), lock };
  });
  return rows.some((row) => row.lock === null) ? rows : null;
}

type RoleNameKey = "role.everyone" | "role.admin" | "role.recruiter";

/**
 * A Role's name as shown. A seeded Role nobody has named yet arrives with a
 * null name and is shown in the reader's language: `@everyone` and Admin by
 * their kind, Davetçi / Recruiter otherwise.
 */
export function roleDisplayName(role: Pick<RoleSummary, "name" | "kind">, t: (key: RoleNameKey) => string) {
  if (role.name !== null) return role.name;
  return t(role.kind === "everyone" ? "role.everyone" : role.kind === "admin" ? "role.admin" : "role.recruiter");
}
