import type { ChatMessageReply, MessageMention } from "@voxly/shared";

/**
 * A Draft: what a member left unsent in one channel's composer.
 *
 * Held in memory only, for as long as the page lives. Switching channels
 * rebuilds the chat screen, so the Draft has to outlive it; closing or
 * reloading the app forgets every Draft on purpose, so nothing a member typed
 * and never sent is ever written to disk. No reminder announces a kept Draft —
 * it simply sits in the composer again.
 */
export interface Draft {
  body: string;
  mentions: MessageMention[];
  replyTo: ChatMessageReply | null;
}

export interface DraftMemory {
  read(userId: string, roomId: string): Draft | null;
  write(userId: string, roomId: string, draft: Draft): void;
}

export function createDraftMemory(): DraftMemory {
  const drafts = new Map<string, Draft>();
  // Keyed by account as well, so a sign-in on the same tab never inherits one.
  const key = (userId: string, roomId: string) => `${userId}\u0000${roomId}`;
  return {
    read: (userId, roomId) => drafts.get(key(userId, roomId)) ?? null,
    write(userId, roomId, draft) {
      // An emptied composer is a deletion the member chose; keep nothing to restore.
      if (draft.body === "" && draft.replyTo === null) drafts.delete(key(userId, roomId));
      else drafts.set(key(userId, roomId), draft);
    }
  };
}

export const composerDrafts = createDraftMemory();
