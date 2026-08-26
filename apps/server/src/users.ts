/**
 * A user account: creating one, the bounds on the name it may carry, and the
 * shape of it a caller is allowed to see.
 *
 * An account is global; a membership is per-server and lives in `members.ts`.
 * That is why this is a leaf rather than a route group. Four route groups need
 * these three functions — bootstrap and `/api/me` in the composition root,
 * invite acceptance and the access claim in `invites.ts`, the member rename in
 * the moderation routes — and a module that imported them from `app.ts` would
 * close the cycle `app.ts` opens by importing it. `rooms.ts` and `members.ts`
 * already answer that shape: what everyone may read becomes a leaf, and only
 * the routes that need live state stay with the composition
 * (`docs/adr/0013-route-modules-register-their-own-routes.md`).
 *
 * `publicUser` is the whole outward shape of an account. `banned_at` here is
 * the global ban; a server ban lives on the membership row and is never merged
 * into this.
 */

import { z } from "zod";
import { audit } from "./audit.js";
import type { AuthUser } from "./auth/sessions.js";
import { run, type VoxlyDatabase } from "./db/database.js";

/** The `users` row as it is read back, in database column spelling. */
export type UserRow = {
  id: string;
  nickname: string;
  role: "owner" | "member";
  banned_at: string | null;
};

/**
 * The name an account may be created with, and the one an owner may give a
 * member on their own server. One schema, so the two cannot drift into
 * accepting different names for the same person.
 */
export const nicknameSchema = z.string().trim().min(2).max(32);

export function createUser(database: VoxlyDatabase, nickname: string, role: "owner" | "member") {
  const user = {
    id: crypto.randomUUID(),
    nickname,
    role,
    bannedAt: null
  };
  run(database.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", [
    user.id,
    user.nickname,
    user.role
  ]);
  audit(database, user.id, "user.created", user.id);
  database.save();
  return user;
}

/** Everything a caller may learn about an account, and deliberately nothing else. */
export function publicUser(user: AuthUser | { id: string; nickname: string; role: "owner" | "member"; bannedAt: string | null }) {
  return {
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    bannedAt: user.bannedAt
  };
}
