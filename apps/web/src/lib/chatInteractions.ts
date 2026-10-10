import type { ChatMessage, MessageMentionInput, MessageReactionState, PresenceUser } from "@voxly/shared";

/** Keep ranges through one textarea edit; editing a label makes it ordinary text. */
export function editMentionRanges<T extends MessageMentionInput>(
  before: string,
  after: string,
  mentions: T[],
  edit?: { start: number; end: number }
): T[] {
  if (before === after && (!edit || edit.start === edit.end)) return mentions;
  let start = edit?.start ?? 0;
  let oldEnd = edit?.end ?? before.length;
  let newEnd = oldEnd + after.length - before.length;
  // Input events and picker insertions supply the exact replaced range. Fall
  // back for external/undo changes only when that range cannot explain the edit.
  if (
    !edit ||
    newEnd < start ||
    before.slice(0, start) !== after.slice(0, start) ||
    before.slice(oldEnd) !== after.slice(newEnd)
  ) {
    start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    oldEnd = before.length;
    newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
  }
  const delta = newEnd - oldEnd;
  return mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention];
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  });
}

/** Keep the caret anchored to authored text when identity labels change length. */
export function rebaseMentionSelection(
  before: MessageMentionInput[],
  after: MessageMentionInput[],
  selection: { start: number; end: number }
) {
  const rebase = (position: number) => {
    let delta = 0;
    for (let index = 0; index < before.length; index++) {
      const old = before[index],
        next = after[index];
      if (!next || old.id !== next.id) return position;
      if (position <= old.start) return position + delta;
      if (position < old.end) return next.start + Math.min(position - old.start, next.end - next.start);
      delta = next.end - old.end;
    }
    return position + delta;
  };
  return { start: rebase(selection.start), end: rebase(selection.end) };
}

export function trimMentionDraft<T extends MessageMentionInput>(body: string, mentions: T[]) {
  const leading = body.length - body.trimStart().length;
  const trimmed = body.trim();
  return {
    body: trimmed,
    mentions: mentions
      .filter((mention) => mention.start >= leading && mention.end <= leading + trimmed.length)
      .map((mention) => ({ ...mention, start: mention.start - leading, end: mention.end - leading }))
  };
}

export function mergeReactionState(current: MessageReactionState, next: MessageReactionState) {
  return next.version >= current.version ? next : current;
}

export function isMentioned(message: Pick<ChatMessage, "mentions" | "userId">, userId: string) {
  return message.userId !== userId && message.mentions.some((mention) => mention.recipientIds.includes(userId));
}

export function mentionCandidates(members: PresenceUser[], onlineIds: Set<string>, query: string) {
  const normalized = query.toLocaleLowerCase();
  return members
    .filter(
      (member) =>
        !member.isBot &&
        Boolean(member.mentionCode) &&
        `${member.nickname} #${member.mentionCode}`.toLocaleLowerCase().includes(normalized)
    )
    .sort(
      (a, b) =>
        Number(onlineIds.has(b.userId)) - Number(onlineIds.has(a.userId)) ||
        a.nickname.localeCompare(b.nickname) ||
        a.mentionCode!.localeCompare(b.mentionCode!)
    );
}

/** Real anchors retain the browser's menu, including their child text/icons. */
export function usesNativeMessageMenu(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a[href], textarea, input"));
}
