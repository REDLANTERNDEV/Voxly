import type { UserRole } from "@voxly/shared";

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
