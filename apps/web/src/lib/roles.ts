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

/**
 * Whether the actor may change, reorder or delete this Role: the owner any;
 * anyone else holding Manage roles only a Role strictly below their own
 * highest, and never Admin. Mirrors what the server checks.
 */
export function canManageRole(actor: RoleActor | undefined, role: Pick<RoleSummary, "kind" | "position">) {
  if (!actor || !holdsPermission(actor, "manageRoles")) return false;
  if (actor.role === "owner") return true;
  if (role.kind === "admin") return false;
  return role.position < actor.rank;
}

/** Why a Role cannot be changed by this actor, or null when it can. */
export function roleEditLock(
  actor: RoleActor | undefined,
  role: Pick<RoleSummary, "kind" | "position">
): "ownerOnly" | "belowYours" | null {
  if (canManageRole(actor, role)) return null;
  return role.kind === "admin" ? "ownerOnly" : "belowYours";
}

/**
 * The movable Roles' ids, top first, after moving one up (-1) or down (+1),
 * or null when the move is not allowed: a fixed Role, the edge of the list,
 * or a swap with a Role the actor may not manage.
 */
export function moveRole(
  actor: RoleActor | undefined,
  roles: readonly RoleSummary[],
  roleId: string,
  direction: -1 | 1
): string[] | null {
  const movable = roles.filter((role) => role.kind === null);
  const index = movable.findIndex((role) => role.id === roleId);
  const other = movable[index + direction];
  const role = movable[index];
  if (!role || !other || !canManageRole(actor, role) || !canManageRole(actor, other)) return null;
  const ids = movable.map((item) => item.id);
  ids[index] = other.id;
  ids[index + direction] = role.id;
  return ids;
}

/**
 * The movable Roles' ids, top first, after dropping one onto another's place,
 * or null when either is out of the actor's reach or nothing moves.
 */
export function dropRole(
  actor: RoleActor | undefined,
  roles: readonly RoleSummary[],
  roleId: string,
  targetId: string
): string[] | null {
  const movable = roles.filter((role) => role.kind === null);
  const from = movable.findIndex((role) => role.id === roleId);
  const to = movable.findIndex((role) => role.id === targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const [lo, hi] = from < to ? [from, to] : [to, from];
  // Every Role whose place changes must be one the actor may manage.
  if (movable.slice(lo, hi + 1).some((role) => !canManageRole(actor, role))) return null;
  const ids = movable.map((item) => item.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved!);
  return ids;
}

/** How many people hold a Role: everyone for `@everyone`, never a Bot. */
export function roleMemberCount(role: Pick<RoleSummary, "id" | "kind">, members: readonly PresenceUser[]) {
  const people = members.filter((member) => !member.isBot);
  if (role.kind === "everyone") return people.length;
  return people.filter((member) => member.roleIds?.includes(role.id)).length;
}

/** The permission list a Clear leaves: Administrator stays unless the owner clears it. */
export function clearedPermissions(
  actor: RoleActor | undefined,
  role: Pick<RoleSummary, "permissions" | "kind">
): Permission[] {
  // Admin holds Administrator always; anyone else's Clear may not drop it either.
  const keep = role.kind === "admin" || (actor?.role !== "owner" && role.permissions.includes("administrator"));
  return keep ? ["administrator"] : [];
}
