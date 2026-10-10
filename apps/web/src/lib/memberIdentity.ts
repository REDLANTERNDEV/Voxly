import type { ChatMessage, ChatMessageReply, MessageMention, PresenceUser } from "@voxly/shared";
import { rewriteMentionLabels } from "@voxly/shared";

/** Scoped facts from member events. Absence is not deletion; null is a tombstone. */
export type MemberIdentityChanges = Readonly<Record<string, PresenceUser | null>>;
export const noMemberIdentityChanges: MemberIdentityChanges = {};

export function reconcileMentionContent<T extends { body: string; mentions: MessageMention[] }>(
  content: T,
  changes: MemberIdentityChanges
): T {
  let changed = false;
  const mentions = content.mentions.map((mention) => {
    if (mention.kind !== "person") return mention;
    const identity = changes[mention.userId];
    if (mention.authorDeleted || identity === null) {
      if (mention.authorDeleted && mention.nickname === "") return mention;
      changed = true;
      return { ...mention, nickname: "", authorDeleted: true };
    }
    if (!identity) return mention;
    const mentionCode = identity.mentionCode ?? mention.mentionCode;
    if (mention.nickname === identity.nickname && mention.mentionCode === mentionCode) return mention;
    changed = true;
    return { ...mention, nickname: identity.nickname, mentionCode };
  });
  return changed ? { ...content, ...rewriteMentionLabels(content.body, mentions) } : content;
}

export function reconcileReplyIdentity<T extends Omit<ChatMessageReply, "messageId">>(
  reply: T,
  changes: MemberIdentityChanges
): T {
  const content = reconcileMentionContent(reply, changes);
  const identity = changes[reply.userId];
  if (reply.authorDeleted || identity === null)
    return content.authorDeleted && content.nickname === ""
      ? content
      : { ...content, nickname: "", authorDeleted: true };
  return identity && identity.nickname !== content.nickname ? { ...content, nickname: identity.nickname } : content;
}

export function reconcileMessageIdentity(message: ChatMessage, changes: MemberIdentityChanges): ChatMessage {
  const content = reconcileReplyIdentity(message, changes);
  const replyTo = content.replyTo ? reconcileReplyIdentity(content.replyTo, changes) : null;
  return replyTo === content.replyTo ? content : { ...content, replyTo };
}

export function renameMentions(mentions: MessageMention[], user: PresenceUser) {
  return mentions.map((mention) =>
    mention.kind === "person" && mention.userId === user.userId && !mention.authorDeleted
      ? { ...mention, nickname: user.nickname, mentionCode: user.mentionCode ?? mention.mentionCode }
      : mention
  );
}

export function anonymizeMentions(mentions: MessageMention[], userId: string) {
  return mentions.map((mention) =>
    mention.kind === "person" && mention.userId === userId ? { ...mention, nickname: "", authorDeleted: true } : mention
  );
}

export function replacePresenceUser(users: PresenceUser[], next: PresenceUser) {
  return users.some((user) => user.userId === next.userId)
    ? users.map((user) => (user.userId === next.userId ? next : user))
    : [...users, next];
}

export function replacePresenceUserIfPresent(users: PresenceUser[], next: PresenceUser) {
  return users.some((user) => user.userId === next.userId)
    ? users.map((user) => (user.userId === next.userId ? next : user))
    : users;
}

export function replaceServerPresenceUserIfPresent(
  usersByServer: Record<string, PresenceUser[]>,
  serverId: string,
  next: PresenceUser
) {
  const users = usersByServer[serverId];
  return users ? { ...usersByServer, [serverId]: replacePresenceUserIfPresent(users, next) } : usersByServer;
}

export function renameMessagesForServer(
  messagesByRoom: Record<string, ChatMessage[]>,
  roomServerIds: Record<string, string>,
  serverId: string,
  user: PresenceUser
) {
  return Object.fromEntries(
    Object.entries(messagesByRoom).map(([roomId, messages]) => [
      roomId,
      roomServerIds[roomId] === serverId
        ? messages.map((message) => ({
            ...message,
            ...(message.userId === user.userId && !message.authorDeleted ? { nickname: user.nickname } : {}),
            ...rewriteMentionLabels(message.body, renameMentions(message.mentions, user)),
            replyTo: message.replyTo
              ? {
                  ...message.replyTo,
                  ...(message.replyTo.userId === user.userId && !message.replyTo.authorDeleted
                    ? { nickname: user.nickname }
                    : {}),
                  ...rewriteMentionLabels(message.replyTo.body, renameMentions(message.replyTo.mentions, user))
                }
              : null
          }))
        : messages
    ])
  );
}

export function anonymizeMessagesForServer(
  messagesByRoom: Record<string, ChatMessage[]>,
  roomServerIds: Record<string, string>,
  serverId: string,
  userId: string
) {
  return Object.fromEntries(
    Object.entries(messagesByRoom).map(([roomId, messages]) => [
      roomId,
      roomServerIds[roomId] === serverId
        ? messages.map((message) => ({
            ...message,
            ...(message.userId === userId ? { nickname: "", authorDeleted: true } : {}),
            ...rewriteMentionLabels(message.body, anonymizeMentions(message.mentions, userId)),
            replyTo: message.replyTo
              ? {
                  ...message.replyTo,
                  ...(message.replyTo.userId === userId ? { nickname: "", authorDeleted: true } : {}),
                  ...rewriteMentionLabels(message.replyTo.body, anonymizeMentions(message.replyTo.mentions, userId))
                }
              : null
          }))
        : messages
    ])
  );
}
