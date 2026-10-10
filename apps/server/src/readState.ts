import type { DatabaseSync } from "node:sqlite";
import { run } from "./db/database.js";

/** Called within membership activation's transaction. A returning member starts clean. */
export function baselineMembershipReadState(sqlite: DatabaseSync, serverId: string, userId: string) {
  run(
    sqlite,
    `insert into room_read_cursors (user_id, room_id, last_read_sequence)
    select ?, id, message_sequence from rooms where server_id = ? and kind = 'text'
    on conflict(user_id, room_id) do update set last_read_sequence = excluded.last_read_sequence`,
    [userId, serverId]
  );
}
