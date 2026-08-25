import type { PresenceUser,PublicUser,UserRole } from "@voxly/shared";

export function canOwnerVoiceModerate(currentRole: UserRole | null, currentUserId: string, target: PresenceUser) {
  return currentRole === "owner" && target.role === "member" && target.userId !== currentUserId;
}

/**
 * The owner actions that presuppose a *person*, which is narrower than voice
 * moderation.
 *
 * Kicking or banning a Bot, delegating invites to it, or minting it a browser
 * access link are all offers the server refuses; presenting them would be a
 * menu of actions that only produce errors. **Moving is in here too**, and it is
 * the one that reads like it should not be: a move says "go there", and the
 * Music bot is only ever sent for. Arriving would put it in a room nobody there
 * summoned it into, and leaving would destroy that room's Queue from a control
 * that never mentioned one. The server refuses it as well; this is
 * presentation, never the enforcement. ADR-0010.
 *
 * Muting, deafening and disconnecting are deliberately not in here. Those mean
 * the same thing for a Bot as for anyone else, and it honours them itself
 * (ADR-0009).
 */
export function canOwnerModeratePerson(currentRole: UserRole | null, currentUserId: string, target: PresenceUser) {
  return canOwnerVoiceModerate(currentRole, currentUserId, target) && !target.isBot;
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
  return directory.find((user) => user.userId === currentUser.id) ?? {
    userId: currentUser.id,
    nickname: currentUser.nickname,
    role: currentUser.role
  };
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
 * Three states, one rule: an entry absent from the online list is offline, an
 * entry present is online unless it reports otherwise. Derived rather than
 * stored so the dot can never disagree with which list the member is in.
 */
export type MemberPresenceState = "online" | "idle" | "offline";

export function memberPresenceState(user: { status?: "online" | "idle" }, online: boolean): MemberPresenceState {
  if (!online) return "offline";
  return user.status === "idle" ? "idle" : "online";
}
