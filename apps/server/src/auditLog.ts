/**
 * A Server's Audit log (ADR-0039): the `audit_events` lines about running one
 * Server, read back for a member holding View audit log.
 *
 * Reading is where the log is narrowed, never writing. Every line stays in the
 * table for the operator (`audit.ts`); this route shows the Server-scoped
 * actions in `auditLogActions` and nothing about an Account's own business, and
 * it withholds what the reader may not otherwise learn:
 *
 * - a private channel's name, from anyone that channel is Hidden from
 *   (ADR-0037), and a deleted private channel's from all but owners and
 *   Administrator holders;
 * - who created an Invite, from anyone but the Server's owner, because that is
 *   the Invite trail (ADR-0034).
 */

import {
  auditLogActions,
  auditLogPageSize,
  type AuditLogAction,
  type AuditLogDetails,
  type AuditLogEntry,
  type AuditLogPerson
} from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { all } from "./db/database.js";
import { requirePermittedServer, type RouteContext } from "./http.js";
import { hasPermission, isServerOwner, roomAccess } from "./members.js";
import { roomById } from "./rooms.js";

type AuditRow = {
  sequence: number;
  id: string;
  actor_user_id: string | null;
  action: AuditLogAction;
  target_user_id: string | null;
  created_at: string;
  details: string | null;
};

/** Actions whose target column holds something other than a member (an Invite's id). */
const targetIsNotAPerson = new Set<AuditLogAction>(["invite.created", "invite.revoked"]);

const querySchema = z.object({
  before: z
    .string()
    .regex(/^[^|]{1,64}\|\d{1,18}$/)
    .optional(),
  actorId: z.string().min(1).max(128).optional(),
  action: z.enum(auditLogActions).optional()
});

export function registerAuditLogRoutes(context: RouteContext) {
  const { fastify, database } = context;

  fastify.get("/api/servers/:serverId/audit-log", async (request, reply) => {
    const scope = requirePermittedServer(context, request, reply, "viewAuditLog");
    if (!scope) return;
    const { user: reader, serverId } = scope;
    const query = querySchema.parse(request.query ?? {});
    return auditLogPage(database.sqlite, serverId, reader.id, query);
  });
}

export function auditLogPage(
  sqlite: DatabaseSync,
  serverId: string,
  readerId: string,
  query: z.infer<typeof querySchema>
) {
  const conditions = ["server_id = ?", `action in (${auditLogActions.map(() => "?").join(", ")})`];
  const values: Array<string | number> = [serverId, ...auditLogActions];
  if (query.action) {
    conditions.push("action = ?");
    values.push(query.action);
  }
  if (query.actorId) {
    conditions.push("actor_user_id = ?");
    values.push(query.actorId);
  }
  if (query.before) {
    // Lines written in the same millisecond keep the order they were written
    // in, which only the rowid knows.
    const [createdAt, sequence] = query.before.split("|") as [string, string];
    conditions.push("(created_at < ? or (created_at = ? and rowid < ?))");
    values.push(createdAt, createdAt, Number(sequence));
  }
  const rows = all<AuditRow>(
    sqlite,
    `select rowid as sequence, id, actor_user_id, action, target_user_id, created_at, details from audit_events
     where ${conditions.join(" and ")}
     order by created_at desc, rowid desc limit ?`,
    [...values, auditLogPageSize + 1]
  );
  const page = rows.slice(0, auditLogPageSize);
  const isOwner = isServerOwner(sqlite, serverId, readerId);
  const seesEveryRoom = isOwner || hasPermission(sqlite, serverId, readerId, "administrator");
  const people = auditPeople(
    sqlite,
    serverId,
    page.flatMap((row) => [row.actor_user_id, targetIsNotAPerson.has(row.action) ? null : row.target_user_id])
  );
  const roomNames = new Map<string, boolean>();
  const mayNameRoom = (details: AuditLogDetails) => {
    if (!details.roomId) return true;
    const known = roomNames.get(details.roomId);
    if (known !== undefined) return known;
    const room = roomById(sqlite, details.roomId);
    const allowed = room ? roomAccess(sqlite, room, readerId).canSee : !details.roomPrivate || seesEveryRoom;
    roomNames.set(details.roomId, allowed);
    return allowed;
  };

  const entries: AuditLogEntry[] = page.map((row) => {
    const details = readDetails(row.details);
    const { roomPrivate: _private, ...shown } = details;
    const visible: AuditLogDetails = mayNameRoom(details)
      ? shown
      : { ...shown, room: undefined, previousRoom: undefined, roomHidden: true };
    const hideActor = row.action === "invite.created" && !isOwner;
    return {
      id: row.id,
      action: row.action,
      createdAt: row.created_at,
      actor: hideActor || !row.actor_user_id ? null : (people.get(row.actor_user_id) ?? null),
      target:
        targetIsNotAPerson.has(row.action) || !row.target_user_id ? null : (people.get(row.target_user_id) ?? null),
      details: visible
    };
  });
  const last = page[page.length - 1];
  return {
    entries,
    nextBefore: rows.length > auditLogPageSize && last ? `${last.created_at}|${last.sequence}` : null
  };
}

function readDetails(raw: string | null): AuditLogDetails {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AuditLogDetails) : {};
  } catch {
    return {};
  }
}

/**
 * The people in a page of lines, named as this Server knows them now. A
 * Deleted account keeps no nickname (ADR-0017); someone who left the Server
 * keeps the Account's own.
 */
function auditPeople(sqlite: DatabaseSync, serverId: string, ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const people = new Map<string, AuditLogPerson>();
  if (wanted.length === 0) return people;
  const rows = all<{
    id: string;
    nickname: string;
    member_nickname: string | null;
    deleted_at: string | null;
    is_bot: number;
  }>(
    sqlite,
    `select u.id, u.nickname, m.nickname as member_nickname, u.deleted_at, u.is_bot
     from users u left join server_members m on m.user_id = u.id and m.server_id = ?
     where u.id in (${wanted.map(() => "?").join(", ")})`,
    [serverId, ...wanted]
  );
  for (const row of rows) {
    people.set(row.id, {
      userId: row.id,
      nickname: row.deleted_at ? null : (row.member_nickname ?? row.nickname),
      isBot: Boolean(row.is_bot)
    });
  }
  return people;
}
