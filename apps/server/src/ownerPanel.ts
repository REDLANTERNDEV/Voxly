/**
 * The global owner's panel: what an owner of the installation may see and do to
 * accounts and sessions across the whole of it — the user list, the session
 * list, the global ban, and closing one session.
 *
 * Not the operator's. In this codebase an operator is the person who self-hosts
 * Voxly — who sets the environment, reads the logs and is the other audience for
 * `audit.ts` — and they hold no account here at all.
 *
 * "Owner" means two different things in this server and this module is the
 * global one. `requireOwner` here reads `users.role`, the installation-wide
 * role; `http.ts`'s `requireOwnedServer` asks who owns the server a path names,
 * and does not fit any of these four even though the user list happens to read
 * `defaultServerId`. Swapping one for the other to share a preamble would widen
 * or narrow who may call these routes.
 *
 * What this module is *not*:
 *
 * - Not owner recovery, which is about *becoming* an owner rather than acting
 *   as one. `auth/ownerClaims.ts` owns those rules — the bootstrap token and the
 *   login claim — and the routes that spend them, `POST /api/bootstrap/owner`
 *   and `POST /api/setup/owner/claim`, are still registered by `app.ts`.
 * - Not the `/api/owner/invites` routes. Those are the server invite operations
 *   with `defaultServerId` substituted for a path parameter, so they live with
 *   the invite rules in `invites.ts` and are covered by its tests.
 * - Not membership moderation. Ban, unban, kick, permissions, nickname and the
 *   voice controls are server-scoped, speak `requireOwnedServer`, and stay in
 *   `app.ts` with the member directory.
 *
 * The four routes share no preamble beyond `requireOwner`, which is already the
 * named rule; there is nothing else in common to lift, since two take no path
 * parameters and the other two take different ones.
 *
 * This module registers its own routes; `app.ts` composes it and hands it a
 * `RouteContext`. See
 * `docs/adr/0013-route-modules-register-their-own-routes.md`.
 */

import { z } from "zod";
import { audit } from "./audit.js";
import {
  allSessions,
  requireOwner,
  revokeSession,
  revokeSessionsForUser
} from "./auth/sessions.js";
import { rejectBotTarget } from "./bots.js";
import { all, defaultServerId, one, run } from "./db/database.js";
import { userIdParam, type RouteContext } from "./http.js";

export function registerOwnerPanelRoutes(context: RouteContext) {
  const { fastify, database, realtime, secureCookies } = context;

  /**
   * Not a list of accounts. It joins from `server_members` scoped to the
   * default server, so it means "who is in this server" — the Music bot
   * included, since a bot is an ordinary member — and a person who joined only
   * some other server is absent from it.
   *
   * The session list below is global, so the two deliberately disagree about
   * who exists: an owner can see a session belonging to somebody this list does
   * not mention, and cannot ban that person from this panel. That is a real gap
   * rather than a formatting difference, and `test/ownerPanel.test.ts` pins both
   * scopes so closing it has to be a decision rather than a tidy-up of two
   * handlers that happen to sit next to each other.
   */
  fastify.get("/api/owner/users", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }

    return {
      users: all(
        database.sqlite,
        `select users.id,
          coalesce(server_members.nickname, users.nickname) as nickname,
          server_members.role,
          server_members.banned_at as bannedAt
         from server_members join users on users.id = server_members.user_id
         where server_members.server_id = ? and server_members.removed_at is null
         order by nickname asc`,
        [defaultServerId]
      )
    };
  });

  /** Every session in the installation, whichever server its holder belongs to. */
  fastify.get("/api/owner/sessions", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }

    return {
      sessions: allSessions(database.sqlite)
    };
  });

  fastify.post("/api/owner/users/:userId/ban", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }
    const { userId } = z.object({ userId: userIdParam }).parse(request.params);
    // A global ban has no undo — the only unban clears a server membership, not
    // `users.banned_at` — and seeding will not replace an account whose
    // membership row still exists. Banning a bot here is unrecoverable.
    if (rejectBotTarget(database, userId, reply)) return;
    const now = new Date().toISOString();
    const target = one<{ role: "owner" | "member" }>(
      database.sqlite,
      "select role from users where id = ?",
      [userId]
    );
    // An owner is exempt, and the exemption is stated twice because the two
    // statements answer for different things: the update refuses to write the
    // ban, and `bannable` refuses to cascade it. Keeping the guard on the write
    // itself means the row cannot be banned by a future caller that forgot to
    // consult `target` first.
    const bannable = target !== null && target.role !== "owner";
    run(database.sqlite, "update users set banned_at = ? where id = ? and role != 'owner'", [
      now,
      userId
    ]);
    // A ban that leaves the account usable is not a ban. Revoking the sessions
    // closes the HTTP path; evicting the sockets closes the realtime path, which
    // otherwise keeps serving messages and WebRTC signalling on the connection
    // that was already open.
    if (bannable) {
      revokeSessionsForUser(database.sqlite, userId, now);
    }
    // Deliberately outside the guard, and deliberately not moved inside it
    // during the extraction. Banning an owner, or a user id that names nobody,
    // answers 204 and writes this line for a ban that did not happen; both are
    // pinned by `test/ownerPanel.test.ts` exactly as they behave. Making the
    // log honest changes what a caller and an operator are told, so it is a
    // behaviour change with its own ticket rather than a tidy-up here.
    audit(database, owner.id, "user.banned", userId);
    database.save();
    if (bannable) {
      realtime.disconnectUser(userId);
    }
    return reply.code(204).send();
  });

  /**
   * Closing one session. A session id that names nothing takes the same 204 and
   * writes the same audit line, the way the ban above does for a user id that
   * names nobody; `test/ownerPanel.test.ts` pins it.
   */
  fastify.post("/api/owner/sessions/:sessionId/revoke", async (request, reply) => {
    const owner = requireOwner(database, request, reply, secureCookies);
    if (!owner) {
      return;
    }
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    revokeSession(database.sqlite, sessionId);
    audit(database, owner.id, "session.revoked", sessionId);
    database.save();
    return reply.code(204).send();
  });
}
