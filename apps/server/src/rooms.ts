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
import { one } from "./db/database.js";

export type RoomRow = {
  id: string;
  serverId: string;
  name: string;
  kind: "text" | "voice";
  /** SQLite has no boolean; `publicRoom` is what turns this into the DTO. */
  isAfkFlag: number;
  position: number;
};

export const roomColumns = "id, server_id as serverId, name, kind, position, coalesce(is_afk, 0) as isAfkFlag";

export function publicRoom(row: RoomRow): RoomSummary {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    kind: row.kind,
    position: row.position,
    isAfk: row.isAfkFlag === 1
  };
}

export function roomById(sqlite: DatabaseSync, roomId: string) {
  const row = one<RoomRow>(
    sqlite,
    `select ${roomColumns} from rooms where id = ?`,
    [roomId]
  );
  return row ? publicRoom(row) : null;
}
