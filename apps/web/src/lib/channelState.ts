import type { RoomKind, RoomSummary } from "@voxly/shared";

export interface RoomHistory {
  [serverId: string]: Partial<Record<RoomKind, string>>;
}

interface RoomHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const roomHistoryKey = "voxly:room-history:v1";

export function rememberRoom(
  history: RoomHistory,
  serverId: string,
  kind: RoomKind,
  roomId: string
): RoomHistory {
  return {
    ...history,
    [serverId]: {
      ...history[serverId],
      [kind]: roomId
    }
  };
}

export function resolveRememberedRoom(rooms: RoomSummary[], rememberedId: string | undefined) {
  return rooms.find((room) => room.id === rememberedId) ?? rooms[0] ?? null;
}

export function roomsForServer(rooms: RoomSummary[], serverId: string) {
  return rooms.filter((room) => room.serverId === serverId);
}

export function resolveServerTextRoom(rooms: RoomSummary[], serverId: string, rememberedId: string | undefined) {
  return resolveRememberedRoom(
    roomsForServer(rooms, serverId).filter((room) => room.kind === "text"),
    rememberedId
  );
}

export function incrementUnread(unread: Record<string, number>, roomId: string) {
  return { ...unread, [roomId]: (unread[roomId] ?? 0) + 1 };
}

export function clearUnread(unread: Record<string, number>, roomId: string) {
  if (!(roomId in unread)) return unread;
  const next = { ...unread };
  delete next[roomId];
  return next;
}

export function unreadAfterMessage(
  unread: Record<string, number>,
  message: { roomId: string; userId: string },
  activeTextRoomId: string | null,
  currentUserId: string
) {
  if (message.userId === currentUserId || message.roomId === activeTextRoomId) return unread;
  return incrementUnread(unread, message.roomId);
}

export function readRoomHistory(storage: Pick<RoomHistoryStorage, "getItem">): RoomHistory {
  try {
    const parsed = JSON.parse(storage.getItem(roomHistoryKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const history: RoomHistory = {};
    for (const [serverId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const text = typeof entry.text === "string" ? entry.text : undefined;
      const voice = typeof entry.voice === "string" ? entry.voice : undefined;
      if (text || voice) history[serverId] = { ...(text ? { text } : {}), ...(voice ? { voice } : {}) };
    }
    return history;
  } catch {
    return {};
  }
}

export function writeRoomHistory(storage: Pick<RoomHistoryStorage, "setItem">, history: RoomHistory) {
  try {
    storage.setItem(roomHistoryKey, JSON.stringify(history));
  } catch {
    return;
  }
}
