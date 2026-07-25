import type { ChatMessage, PresenceUser } from "@voxly/shared";

export function replacePresenceUser(users: PresenceUser[], next: PresenceUser) {
  return users.some((user) => user.userId === next.userId)
    ? users.map((user) => user.userId === next.userId ? next : user)
    : [...users, next];
}

export function replacePresenceUserIfPresent(users: PresenceUser[], next: PresenceUser) {
  return users.some((user) => user.userId === next.userId)
    ? users.map((user) => user.userId === next.userId ? next : user)
    : users;
}

export function replaceServerPresenceUserIfPresent(
  usersByServer: Record<string, PresenceUser[]>,
  serverId: string,
  next: PresenceUser
) {
  const users = usersByServer[serverId];
  return users
    ? { ...usersByServer, [serverId]: replacePresenceUserIfPresent(users, next) }
    : usersByServer;
}

export function renameMessagesForServer(
  messagesByRoom: Record<string, ChatMessage[]>,
  roomServerIds: Record<string, string>,
  serverId: string,
  user: PresenceUser
) {
  return Object.fromEntries(Object.entries(messagesByRoom).map(([roomId, messages]) => [
    roomId,
    roomServerIds[roomId] === serverId
      ? messages.map((message) => message.userId === user.userId
        ? { ...message, nickname: user.nickname }
        : message)
      : messages
  ]));
}
