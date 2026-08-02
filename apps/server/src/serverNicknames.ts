import type { PresenceUser } from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { all, one } from "./db/database.js";

interface PresenceUserRow extends Record<string, unknown>, Omit<PresenceUser, "canInvite"> {
  canInvite: number;
}

const presenceColumns = `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role,
      server_members.can_invite as canInvite`;

function toPresenceUser(row: PresenceUserRow): PresenceUser {
  return { userId: row.userId, nickname: row.nickname, role: row.role, canInvite: Boolean(row.canInvite) };
}

export function serverPresenceUser(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  const row = one<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null`,
    [serverId, userId]
  );
  return row ? toPresenceUser(row) : null;
}

export function serverPresenceUserIncludingBanned(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  const row = one<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.removed_at is null`,
    [serverId, userId]
  );
  return row ? toPresenceUser(row) : null;
}

export function serverPresenceUsers(
  sqlite: DatabaseSync,
  serverId: string,
  userIds: Iterable<string>
): PresenceUser[] {
  const activeIds = new Set(userIds);
  if (activeIds.size === 0) return [];
  return all<PresenceUserRow>(
    sqlite,
    `${presenceColumns}
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null
     order by nickname asc`,
    [serverId]
  ).filter((user) => activeIds.has(user.userId)).map(toPresenceUser);
}
