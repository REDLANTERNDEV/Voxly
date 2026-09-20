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
      ? messages.map((message) => message.userId === user.userId && !message.authorDeleted
        ? { ...message, nickname: user.nickname }
        : message)
      : messages
  ]));
}

export function anonymizeMessagesForServer(
  messagesByRoom: Record<string, ChatMessage[]>,
  roomServerIds: Record<string, string>,
  serverId: string,
  userId: string
) {
  return Object.fromEntries(Object.entries(messagesByRoom).map(([roomId, messages]) => [
    roomId,
    roomServerIds[roomId] === serverId
      ? messages.map((message) => ({
        ...message,
        ...(message.userId === userId ? { nickname: "", authorDeleted: true } : {}),
        replyTo: message.replyTo?.userId === userId
          ? { ...message.replyTo, nickname: "", authorDeleted: true }
          : message.replyTo
      }))
      : messages
  ]));
}
