import type { ChatMessageReply } from "@voxly/shared";

/**
 * Local echo for composed messages.
 *
 * A draft leaves the composer the moment it is submitted so the reader can keep
 * typing while the previous message is still in flight. Until the server
 * acknowledges it the message lives here rather than in the room history: an
 * outbox entry has no server id, so it can never collide with a real message or
 * with the `message:new` broadcast the sender receives for their own writes.
 */
export type OutboxStatus = "pending" | "failed";

export interface OutboxEntry {
  localId: string;
  body: string;
  createdAt: string;
  status: OutboxStatus;
  /** Carried through a retry so a queued reply never loses its target. */
  replyTo: ChatMessageReply | null;
}

export function appendOutboxEntry(entries: OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  return [...entries, entry];
}

export function setOutboxEntryStatus(entries: OutboxEntry[], localId: string, status: OutboxStatus): OutboxEntry[] {
  return entries.map((entry) => (entry.localId === localId ? { ...entry, status } : entry));
}

export function removeOutboxEntry(entries: OutboxEntry[], localId: string): OutboxEntry[] {
  return entries.filter((entry) => entry.localId !== localId);
}

/**
 * Appended-message detection drives auto-scroll, and a local echo is an append
 * like any other. Pending ids are folded into the same id list so submitting
 * scrolls the composer's own message into view immediately rather than only
 * once the server answers.
 */
export function messageListIds(messageIds: string[], entries: OutboxEntry[]): string[] {
  return [...messageIds, ...entries.map((entry) => entry.localId)];
}
