import type { DatabaseSync } from "node:sqlite";

/** Explicit projections: credentials and their hashes never enter the report. */
export function sessionDiagnostics(sqlite: DatabaseSync, accountId: string) {
  const columns = (table: "sessions" | "audit_events") =>
    new Set(
      sqlite
        .prepare(`pragma table_info(${table})`)
        .all()
        .map((row) => String(row.name))
    );
  const sessionColumns = columns("sessions");
  const auditColumns = columns("audit_events");
  const sessions = sqlite
    .prepare(
      `select id, created_at, expires_at, revoked_at,
    ${sessionColumns.has("last_seen_at") ? "last_seen_at" : "null as last_seen_at"},
    ${sessionColumns.has("label") ? "label" : "null as label"},
    ${sessionColumns.has("origin") ? "origin" : "null as origin"}
    from sessions where user_id = ? order by rowid desc`
    )
    .all(accountId);
  const sessionId = auditColumns.has("session_id") ? "session_id" : "null";
  const events = sqlite
    .prepare(
      `select action, actor_user_id, target_user_id, created_at, ${sessionId} as session_id
    from audit_events
    where (target_user_id = ?
      or target_user_id in (select id from sessions where user_id = ?)
      or ${sessionId} in (select id from sessions where user_id = ?))
      and (action like 'session.%' or action in ('device.revoked', 'recovery.used', 'user.banned',
        'account.deleted', 'access_link.consumed'))
    order by created_at, rowid`
    )
    .all(accountId, accountId, accountId);
  return { accountId, generatedAt: new Date().toISOString(), sessions, events };
}
