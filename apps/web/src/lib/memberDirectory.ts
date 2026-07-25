import type { PresenceUser,PublicUser,UserRole } from "@voxly/shared";

export function canOwnerVoiceModerate(currentRole: UserRole | null, currentUserId: string, target: PresenceUser) {
  return currentRole === "owner" && target.role === "member" && target.userId !== currentUserId;
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
