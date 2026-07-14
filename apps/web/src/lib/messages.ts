import type { UserRole } from "@voxly/shared";

export function formatMessageDateTime(value: string, language: string) {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

export function messagePermissions(input: {
  currentUserId: string;
  currentUserRole: UserRole;
  messageUserId: string;
}) {
  const isOwn = input.currentUserId === input.messageUserId;
  return {
    canEdit: isOwn,
    canDelete: isOwn || input.currentUserRole === "owner"
  };
}

export function messageDeleteFailureCopy<T extends string>(status: number | undefined, t: (key: T) => string) {
  const key = status === 403 ? "room.messageCouldNotDeleteSession" : "room.messageCouldNotDelete";
  return t(key as T);
}

export function shouldSubmitComposer(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  isSending: boolean;
}) {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing && !input.isSending;
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
