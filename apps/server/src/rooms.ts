/**
 * Room rows and the summary shape the rest of the server hands out.
 *
 * Every HTTP route and every realtime handler has to look a room up before it
 * can authorize anything against it, so the column list, the row shape, and the
 * row-to-DTO conversion live in one place rather than being re-derived by each
 * caller that needs a room's server or kind.
 */

import type { DatabaseSync } from "node:sqlite";
import type { RoomSummary } from "@voxly/shared";
import { all, one } from "./db/database.js";
import { roomAccess, roomGrantRoleIds, roomGrantUserIds } from "./members.js";

export type RoomRow = {
  id: string;
  serverId: string;
  name: string;
  kind: "text" | "voice";
  /** SQLite has no boolean; `publicRoom` is what turns this into the DTO. */
  isAfkFlag: number;
  isPrivateFlag: number;
  listedFlag: number;
  position: number;
  categoryId: string | null;
};

export const roomColumns =
  "id, server_id as serverId, name, kind, position, category_id as categoryId, coalesce(is_afk, 0) as isAfkFlag, coalesce(is_private, 0) as isPrivateFlag, coalesce(listed, 0) as listedFlag";

export function publicRoom(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    kind: row.kind,
    position: row.position,
    categoryId: row.categoryId,
    isAfk: row.isAfkFlag === 1,
    isPrivate: row.isPrivateFlag === 1,
    listed: row.isPrivateFlag === 1 && row.listedFlag === 1,
    // The server-side default; `roomForViewer` narrows it per member.
    canEnter: true
  };
}

export function roomById(sqlite: DatabaseSync, roomId: string) {
  const row = one<RoomRow>(sqlite, `select ${roomColumns} from rooms where id = ?`, [roomId]);
  return row ? publicRoom(row) : null;
}

/**
 * One channel as a particular member may see it, or null when it is a Hidden
 * channel they have no access to (ADR-0037). `accessUserIds` goes only to a
 * viewer who can enter, because the list itself is part of what is private.
 */
export function roomForViewer(sqlite: DatabaseSync, room: RoomSummary, userId: string): RoomSummary | null {
  if (!room.isPrivate) return room;
  const access = roomAccess(sqlite, room, userId);
  if (!access.canSee) return null;
  return access.canEnter
    ? {
        ...room,
        canEnter: true,
        accessUserIds: roomGrantUserIds(sqlite, room.id),
        accessRoleIds: roomGrantRoleIds(sqlite, room.id)
      }
    : { ...room, canEnter: false };
}

/** A server's channels in sidebar order, as one member may see them. */
export function roomsVisibleTo(sqlite: DatabaseSync, serverId: string, userId: string) {
  return all<RoomRow>(sqlite, `select ${roomColumns} from rooms where server_id = ? order by position asc`, [serverId])
    .map(publicRoom)
    .flatMap((room) => {
      const visible = roomForViewer(sqlite, room, userId);
      return visible ? [visible] : [];
    });
}
