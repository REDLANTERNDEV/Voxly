import type { PresenceUser } from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { all, one } from "./db/database.js";

interface PresenceUserRow extends Record<string, unknown>, PresenceUser {}

export function serverPresenceUser(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  return one<PresenceUserRow>(
    sqlite,
    `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null`,
    [serverId, userId]
  ) ?? null;
}

export function serverPresenceUserIncludingBanned(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  return one<PresenceUserRow>(
    sqlite,
    `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.removed_at is null`,
    [serverId, userId]
  ) ?? null;
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
    `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null
     order by nickname asc`,
    [serverId]
  ).filter((user) => activeIds.has(user.userId));
}
