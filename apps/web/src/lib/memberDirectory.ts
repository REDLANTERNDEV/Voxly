import type { PresenceStatus, PresenceUser, PublicUser, RoleSummary, RoomSummary } from "@voxly/shared";
import { holdsPermission, memberRank, type RoleActor } from "./roles.js";

/** Who is acting, with what the server reported their Roles make them here. */
export interface ModerationActor extends RoleActor {
  userId: string;
}

type ModerationTarget = Pick<PresenceUser, "userId" | "role" | "roleIds" | "isBot">;

/**
 * Whether the actor stands strictly above the target (ADR-0038, decision 4):
 * the owner above everyone but an owner, anyone else above a lower rank. Nobody
 * acts on themselves or on an owner. Mirrors what the server checks.
 */
export function outranksMember(actor: ModerationActor, roles: readonly RoleSummary[], target: ModerationTarget) {
  if (target.role === "owner" || target.userId === actor.userId) return false;
  if (actor.role === "owner") return true;
  return memberRank(roles, target) < actor.rank;
}

/** Mute, deafen and disconnect: Voice moderation over someone below, a Bot included (ADR-0009). */
export function canVoiceModerate(
  actor: ModerationActor | undefined,
  roles: readonly RoleSummary[],
  target: ModerationTarget
) {
  return Boolean(actor && holdsPermission(actor, "voiceModeration") && outranksMember(actor, roles, target));
}

/**
 * A move, which presupposes a *person*: a move says "go there", and the Music
 * bot is only ever sent for. Arriving would put it in a room nobody there
 * summoned it into, and leaving would destroy that room's Queue from a control
 * that never mentioned one. The server refuses it as well; this is
 * presentation, never the enforcement. ADR-0010.
 */
export function canMovePerson(
  actor: ModerationActor | undefined,
  roles: readonly RoleSummary[],
  target: ModerationTarget
) {
  return canVoiceModerate(actor, roles, target) && !target.isBot;
}

/**
 * Kick and ban: Manage members over a person below. A Bot cannot leave or be
 * invited back, so it is never offered them (ADR-0010).
 */
export function canModeratePerson(
  actor: ModerationActor | undefined,
  roles: readonly RoleSummary[],
  target: ModerationTarget
) {
  return Boolean(
    actor && holdsPermission(actor, "manageMembers") && outranksMember(actor, roles, target) && !target.isBot
  );
}

/** Renaming someone else: Manage members over someone below. Your own name is always yours. */
export function canRenameMember(
  actor: ModerationActor | undefined,
  roles: readonly RoleSummary[],
  target: ModerationTarget
) {
  if (actor && target.userId === actor.userId) return true;
  return Boolean(actor && holdsPermission(actor, "manageMembers") && outranksMember(actor, roles, target));
}

/**
 * How many *people* are here. A Bot is always present and never joined, so
 * counting it would inflate every figure a member reads as "how busy is it".
 * It still appears in the list itself — this is the count, not the roster.
 */
export function countPeople(users: Array<{ isBot?: boolean }>) {
  return users.filter((user) => !user.isBot).length;
}

export function currentServerPresence(currentUser: PublicUser, directory: PresenceUser[]): PresenceUser {
  return (
    directory.find((user) => user.userId === currentUser.id) ?? {
      userId: currentUser.id,
      nickname: currentUser.nickname,
      role: currentUser.role
    }
  );
}

export function groupDirectoryMembers(
  directory: PresenceUser[],
  onlineUsers: PresenceUser[],
  currentUser: PresenceUser
) {
  const members = new Map(directory.map((user) => [user.userId, user]));
  for (const user of onlineUsers) members.set(user.userId, user);
  members.set(currentUser.userId, currentUser);

  const onlineIds = new Set([...onlineUsers.map((user) => user.userId), currentUser.userId]);
  const byNickname = (left: PresenceUser, right: PresenceUser) => left.nickname.localeCompare(right.nickname);
  const allMembers = [...members.values()];

  return {
    online: allMembers.filter((user) => onlineIds.has(user.userId)).sort(byNickname),
    offline: allMembers.filter((user) => !onlineIds.has(user.userId)).sort(byNickname)
  };
}

/**
 * One rule: an entry absent from the online list is offline, an entry present
 * is online unless it reports otherwise. Derived rather than stored so the dot
 * can never disagree with which list the member is in. Invisible is only ever
 * the member's own view of themselves; everyone else sees them as offline.
 */
export type MemberPresenceState = "online" | "idle" | "dnd" | "invisible" | "offline";

export function memberPresenceState(user: { status?: PresenceStatus }, online: boolean): MemberPresenceState {
  if (!online) return "offline";
  return user.status === "idle" || user.status === "dnd" ? user.status : "online";
}

/**
 * Whether a member may enter a channel, as far as the viewer can tell
 * (ADR-0037, ADR-0038): a public channel lets everyone in; a private one lets
 * in owners, its Channel access by person or by a Role the member holds (sent
 * only to a viewer who can enter), and anyone whose Roles carry Administrator.
 * The server decides; this only keeps the move menu and Mention picker from
 * offering what it would refuse.
 */
export function canMemberEnter(
  room: Pick<RoomSummary, "isPrivate" | "accessUserIds" | "accessRoleIds">,
  member: Pick<PresenceUser, "userId" | "role" | "roleIds" | "isBot">,
  roles: readonly RoleSummary[] = []
) {
  if (!room.isPrivate || member.role === "owner") return true;
  if (room.accessUserIds?.includes(member.userId)) return true;
  if (member.isBot) return false;
  const held = new Set(member.roleIds ?? []);
  if (room.accessRoleIds?.some((roleId) => held.has(roleId))) return true;
  return roles.some(
    (role) => (role.kind === "everyone" || held.has(role.id)) && role.permissions.includes("administrator")
  );
}
