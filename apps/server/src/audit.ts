/**
 * The server's audit log: one durable row per consequential action, kept for
 * the operator and the owners who have to answer for it later. Not the Set log,
 * which is the Music bot's in-memory record of one Set and is gone when the Set
 * ends (`CONTEXT.md`).
 *
 * A server created or deleted, a member banned, an invite revoked, a session
 * closed: the rows outlive the things they describe. `AGENTS.md` forbids
 * dropping or reinterpreting them as an incidental cleanup, so server deletion
 * deliberately writes its line and leaves the history behind rather than taking
 * it along.
 *
 * The write joins whatever transaction the caller is already in and never saves
 * on its own. A deletion that committed its audit line separately from the
 * deletion itself could leave a record of something that did not happen, or
 * lose the record of something that did.
 */

import { defaultServerId, run, type VoxlyDatabase } from "./db/database.js";

export function audit(
  database: VoxlyDatabase,
  actorUserId: string | null,
  action: string,
  targetUserId: string | null,
  serverId: string = defaultServerId
) {
  run(
    database.sqlite,
    "insert into audit_events (id, actor_user_id, action, target_user_id, server_id, created_at) values (?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), actorUserId, action, targetUserId, serverId, new Date().toISOString()]
  );
}
