import { welcomeWaveBody, type ChatMessage, type ChatMessageKind, type UserRole } from "@voxly/shared";
import { timeFormatOptions, type TimeFormatPreference } from "./timeFormat.js";

export function formatMessageDateTime(value: string, language: string, timeFormat: TimeFormatPreference = "auto") {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...timeFormatOptions(timeFormat)
  }).format(new Date(value));
}

export function formatMessageTimestamp(
  value: string,
  language: string,
  now = new Date(),
  timeFormat: TimeFormatPreference = "auto"
) {
  const date = new Date(value);
  const isToday =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    language,
    isToday
      ? { hour: "2-digit", minute: "2-digit", ...timeFormatOptions(timeFormat) }
      : { dateStyle: "medium", timeStyle: "short", ...timeFormatOptions(timeFormat) }
  ).format(date);
}

export function messagePermissions(input: {
  currentUserId: string;
  currentUserRole: UserRole;
  messageUserId: string;
  messageKind?: ChatMessageKind;
}) {
  const isOwn = input.currentUserId === input.messageUserId;
  return {
    // A Welcome notice is in its member's name but has no body of theirs to edit.
    canEdit: isOwn && input.messageKind !== "memberJoined",
    canDelete: isOwn || input.currentUserRole === "owner"
  };
}

/**
 * The Welcome notices this member has already waved at, from the loaded
 * history. The server refuses a second wave either way; this only keeps the
 * button from offering one.
 */
export function wavedNotices(messages: readonly ChatMessage[], userId: string) {
  return new Set(
    messages.flatMap((message) =>
      message.userId === userId && message.replyToMessageId && message.body === welcomeWaveBody
        ? [message.replyToMessageId]
        : []
    )
  );
}

/** Everyone but the member it welcomes may wave, once, while they are still a member. */
export function canWaveAt(message: ChatMessage, userId: string, waved: boolean) {
  return message.kind === "memberJoined" && message.userId !== userId && !message.authorDeleted && !waved;
}

/**
 * Splits a translated sentence around the nickname so it can be set apart
 * without assembling the sentence from fragments: Turkish and English put it
 * in different places.
 */
export function aroundNickname(translate: (nickname: string) => string) {
  const marker = "\u0000";
  const [before = "", after = ""] = translate(marker).split(marker);
  return { before, after };
}

export function messageDeleteFailureCopy<T extends string>(status: number | undefined, t: (key: T) => string) {
  const key = status === 403 ? "room.messageCouldNotDeleteSession" : "room.messageCouldNotDelete";
  return t(key as T);
}

/**
 * Submission is never gated on a previous send. An in-flight request used to
 * swallow every Enter pressed while it was open, which lost keystrokes outright
 * on a slow link; delivery is ordered by the outbox instead.
 */
export function shouldSubmitComposer(input: { key: string; shiftKey: boolean; isComposing: boolean }) {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export function isMessageListNearBottom(
  input: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 48
) {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

export function messageListUpdateAction(
  previousIds: string[],
  currentIds: string[],
  wasNearBottom: boolean
): "scroll" | "notify" | "none" {
  const previous = new Set(previousIds);
  const hasAppendedMessage = currentIds.some((id) => !previous.has(id));
  if (!hasAppendedMessage) return "none";
  return wasNearBottom ? "scroll" : "notify";
}
