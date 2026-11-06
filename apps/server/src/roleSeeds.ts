/**
 * The three Roles every Server starts with, and the one-time upgrade that gives
 * them to Servers made before Roles existed (ADR-0038).
 *
 * A leaf over the raw SQLite handle, because `db/database.ts` runs it while it
 * opens the file and must not import anything that imports it back.
 *
 * `servers.roles_seeded_at` is the marker. A Server is seeded once: a restart
 * never makes a second set, and never gives back a Davetçi its owner deleted.
 */

import type { DatabaseSync } from "node:sqlite";
import type { Permission } from "@voxly/shared";

type SeedRow = {
  seed: "everyone" | "recruiter" | "admin";
  kind: "everyone" | "admin" | null;
  position: number;
  permissions: Permission[];
};

/**
 * `@everyone` carries nothing, so the upgrade gives nobody a right they did not
 * have. Admin holds Administrator; Davetçi holds Create invites and is an
 * ordinary Role from then on. A seeded Role keeps a null name until someone
 * names it, and each client shows its own localized name meanwhile.
 */
const seeds: readonly SeedRow[] = [
  { seed: "everyone", kind: "everyone", position: 0, permissions: [] },
  { seed: "recruiter", kind: null, position: 1, permissions: ["createInvites"] },
  { seed: "admin", kind: "admin", position: 2, permissions: ["administrator"] }
];

/**
 * Makes a Server's three Roles, unless it already has them, and places every
 * Membership that held the old per-member invite switch in Davetçi. Joins the
 * caller's transaction, if any.
 */
export function seedServerRoles(sqlite: DatabaseSync, serverId: string, now: string) {
  const server = sqlite.prepare("select roles_seeded_at from servers where id = ?").get(serverId) as
    { roles_seeded_at: string | null } | undefined;
  if (!server || server.roles_seeded_at) return;
  const insert = sqlite.prepare(
    "insert into roles (id, server_id, name, kind, seed, position, permissions, created_at) values (?, ?, null, ?, ?, ?, ?, ?)"
  );
  let recruiterId = "";
  for (const row of seeds) {
    const id = crypto.randomUUID();
    if (row.seed === "recruiter") recruiterId = id;
    insert.run(id, serverId, row.kind, row.seed, row.position, JSON.stringify(row.permissions), now);
  }
  // Owners already hold everything, and a Bot holds no Roles; an ended
  // Membership's switch was already inert, so it is not carried over either.
  sqlite
    .prepare(
      `insert or ignore into member_roles (server_id, user_id, role_id, granted_at)
       select m.server_id, m.user_id, ?, ? from server_members m join users u on u.id = m.user_id
       where m.server_id = ? and m.can_invite = 1 and m.role = 'member' and u.is_bot = 0 and m.removed_at is null`
    )
    .run(recruiterId, now, serverId);
  sqlite.prepare("update servers set roles_seeded_at = ? where id = ?").run(now, serverId);
}

/** Every Server not yet seeded, each in its own transaction. Safe to run on every start. */
export function seedMissingServerRoles(sqlite: DatabaseSync) {
  const now = new Date().toISOString();
  const servers = sqlite.prepare("select id from servers where roles_seeded_at is null").all() as Array<{ id: string }>;
  for (const { id } of servers) {
    sqlite.exec("begin immediate");
    try {
      seedServerRoles(sqlite, id, now);
      sqlite.exec("commit");
    } catch (cause) {
      sqlite.exec("rollback");
      throw cause;
    }
  }
}
