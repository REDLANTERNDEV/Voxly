import type { PresenceUser } from "@voxly/shared";

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
