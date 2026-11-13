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

import type { AuditLogDetails, RoomSummary } from "@voxly/shared";
import { defaultServerId, run, type VoxlyDatabase } from "./db/database.js";

/**
 * Writes one audit line. `details` names what the action touched — a channel,
 * a Role, a move's destination — at the time it happened, so the Audit log
 * still reads after the thing is renamed or gone. It never holds message
 * text, a token or anything a member typed beyond a name.
 */
export function audit(
  database: VoxlyDatabase,
  actorUserId: string | null,
  action: string,
  targetUserId: string | null,
  serverId: string = defaultServerId,
  sessionId: string | null = null,
  details: AuditLogDetails | null = null
) {
  const recorded = details && Object.keys(details).length > 0 ? JSON.stringify(details) : null;
  run(
    database.sqlite,
    "insert into audit_events (id, actor_user_id, action, target_user_id, server_id, created_at, session_id, details) values (?, ?, ?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), actorUserId, action, targetUserId, serverId, new Date().toISOString(), sessionId, recorded]
  );
}

/**
 * The room an audit line touched or happened in, named as it was. Whether it
 * was private goes with it, so reading the line back can withhold a Hidden
 * channel's name from someone who cannot see that channel (ADR-0037).
 */
export function auditRoom(
  room: Pick<RoomSummary, "id" | "name" | "kind" | "isPrivate">,
  isPrivate: boolean = room.isPrivate
): AuditLogDetails {
  return { roomId: room.id, room: room.name, roomKind: room.kind, roomPrivate: isPrivate };
}
