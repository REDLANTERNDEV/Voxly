import { chatEmojiSet } from "@voxly/shared";
import { useSyncExternalStore } from "react";
import type { StorageLike } from "./voiceVolume.js";

/**
 * The emoji this Device used last, for the message toolbar's quick reactions
 * and the picker's Recently used row.
 *
 * It is a convenience, not a preference: it lives in this browser only, holds
 * nothing but catalogue glyphs, and an empty or unreadable store simply falls
 * back to the defaults.
 */

export const recentEmojiStorageKey = "voxly:recent-emoji:v1";
export const recentEmojiLimit = 24;
export const quickReactionCount = 3;
export const defaultQuickReactions = ["👍", "❤️", "😂"] as const;

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Most recent first, only catalogue glyphs, each once. */
export function readRecentEmoji(storage = browserStorage()): string[] {
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(recentEmojiStorageKey) ?? "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const emoji of value) {
      if (typeof emoji === "string" && chatEmojiSet.has(emoji)) seen.add(emoji);
      if (seen.size >= recentEmojiLimit) break;
    }
    return [...seen];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

export function rememberEmoji(emoji: string, storage = browserStorage()) {
  if (!storage || !chatEmojiSet.has(emoji)) return;
  const next = [emoji, ...readRecentEmoji(storage).filter((entry) => entry !== emoji)].slice(0, recentEmojiLimit);
  try {
    storage.setItem(recentEmojiStorageKey, JSON.stringify(next));
  } catch {
    return;
  }
  for (const listener of listeners) listener();
}

/** The toolbar's three: the most recent, topped up with the defaults. */
export function quickReactions(recent: readonly string[]): string[] {
  const picked = new Set(recent.slice(0, quickReactionCount));
  for (const emoji of defaultQuickReactions) {
    if (picked.size >= quickReactionCount) break;
    picked.add(emoji);
  }
  return [...picked];
}

let cachedRaw: string | null | undefined;
let cachedList: string[] = [];
function snapshot() {
  let raw: string | null;
  try {
    raw = browserStorage()?.getItem(recentEmojiStorageKey) ?? null;
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = readRecentEmoji();
  }
  return cachedList;
}
const serverSnapshot: string[] = [];

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders every toolbar and picker when any of them records a use. */
export function useRecentEmoji() {
  return useSyncExternalStore(subscribe, snapshot, () => serverSnapshot);
}
