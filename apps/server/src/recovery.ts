/**
 * The way back into an account with no signed-in Device left.
 *
 * A member whose only Device is lost, wiped or cleared cannot use a Link code —
 * there is nothing left to link *from*. Voxly has no password and no email, so
 * the only thing that can prove they are who they say is something they held
 * beforehand. That is what this is: one durable secret, issued once, replaced
 * whenever it is used.
 *
 * **Redeeming revokes every other session and issues a fresh code.** That is
 * the security design and not an incidental behaviour. A stolen Recovery code
 * cannot be used quietly: using it signs the real member out everywhere and
 * stops their saved code working, so theft announces itself at the moment it
 * happens rather than months later. It also keeps the two paths honestly
 * separated — Recovery means "I lost my Device", and a member who merely wants
 * a second one is pushed to the Link code, which costs them nothing.
 *
 * See ADR-0014. Do not soften the revocation without revisiting it there.
 */

import { z } from "zod";
import { audit } from "./audit.js";
import { createSession, revokeOtherSessionsForUser, revokeSessionsForUser, setSessionCookie } from "./auth/sessions.js";
import { requireUser } from "./auth/sessions.js";
import { createLinkCode, normaliseLinkCode } from "./auth/linkCode.js";
import { hashToken } from "./auth/tokens.js";
import { one, run, type VoxlyDatabase } from "./db/database.js";
import { authenticatedWriteLimit, type RouteContext } from "./http.js";
import { verifyTurnstile } from "./turnstile.js";
import { publicUser, type UserRow } from "./users.js";

/**
 * Tighter than `unauthenticatedWriteLimit`. This is the one endpoint where a
 * correct guess is the whole account, and unlike a Link code it has no expiry
 * bounding how long guessing is worth attempting.
 */
const recoverLimit = { rateLimit: { max: 5, timeWindow: "1 minute" } };

/**
 * Twenty-five characters of the same Crockford alphabet the Link code uses:
 * 125 bits, five groups of five.
 *
 * Deliberately *not* `createOpaqueToken()`, which is base64url and can contain
 * a literal `-`. This code is grouped with dashes for anybody writing it on
 * paper, so a token that may itself contain one cannot be normalised back
 * unambiguously — a recovery code that silently fails for one member in eight
 * is worse than no recovery code at all.
 *
 * Sharing the alphabet also means no I/L/O/U to misread, which matters more
 * here than anywhere: this is the secret most likely to be copied by hand.
 */
export const recoveryCodeLength = 25;

export function formatRecoveryCode(token: string) {
  return (token.match(/.{1,5}/g) ?? [token]).join("-");
}

export function normaliseRecoveryCode(input: string) {
  return normaliseLinkCode(input, recoveryCodeLength);
}

/**
 * Replace whatever the account had. Regenerating and redeeming both land here,
 * so there is exactly one live code per account at any moment and only one
 * place that has to be true.
 */
export function issueRecoveryCode(database: VoxlyDatabase, userId: string, now = new Date()) {
  const token = createLinkCode(recoveryCodeLength);
  run(
    database.sqlite,
    "update recovery_codes set replaced_at = ? where user_id = ? and used_at is null and replaced_at is null",
    [now.toISOString(), userId]
  );
  run(
    database.sqlite,
    "insert into recovery_codes (id, token_hash, user_id, created_at) values (?, ?, ?, ?)",
    [crypto.randomUUID(), hashToken(token), userId, now.toISOString()]
  );
  return formatRecoveryCode(token);
}

export function hasRecoveryCode(database: VoxlyDatabase, userId: string) {
  return Boolean(one<{ id: string }>(
    database.sqlite,
    "select id from recovery_codes where user_id = ? and used_at is null and replaced_at is null",
    [userId]
  ));
}

export function registerRecoveryRoutes({ fastify, database, realtime, secureCookies, turnstile }: RouteContext) {
  /** Whether the member has one, never the code itself — that is shown once. */
  fastify.get("/api/recovery", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    return reply.send({ present: hasRecoveryCode(database, user.id) });
  });

  /**
   * Issue a Recovery code, or replace the one the account has.
   *
   * **Replacing signs every other Device out. Creating the first one does not.**
   *
   * The two are different acts wearing one button. Creating your first code is
   * preventive — a member setting up a safety net has nothing to be alarmed
   * about, and signing them out of everything for it would be a punishment for
   * being careful. Replacing one is almost always a reaction: the old code was
   * seen, written somewhere it should not have been, or simply lost track of.
   * That is the moment to clear the account out, and a member who has just
   * decided their old code is untrustworthy should not have to go and revoke
   * Devices one at a time afterwards.
   *
   * The Device asking is kept. Signing out the one in their hand would leave
   * them with nothing to act from, holding a brand new code they would then
   * have to use immediately.
   */
  fastify.post("/api/recovery", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    if (user.isBot) return reply.code(409).send({ error: "bot_has_no_devices" });

    const replacing = hasRecoveryCode(database, user.id);
    const code = issueRecoveryCode(database, user.id);
    if (replacing) {
      revokeOtherSessionsForUser(database.sqlite, user.id, user.sessionId);
      audit(database, user.id, "recovery.replaced", user.id);
    } else {
      audit(database, user.id, "recovery.issued", user.id);
    }
    database.save();
    if (replacing) realtime.disconnectOtherDevices(user.id, user.sessionId);
    // The only time the value is ever returned. It is not stored in a form
    // anything can read back, so a member who does not save it now must
    // generate another.
    return reply.code(201).send({ code, signedOutOthers: replacing });
  });

  fastify.post("/api/recovery/redeem", { config: recoverLimit }, async (request, reply) => {
    const parsed = z
      .object({ code: z.string().min(1).max(200), turnstileToken: z.string().optional() })
      .safeParse(request.body);
    // The one endpoint where a correct guess is the whole account, and the one
    // with no expiry bounding how long guessing is worth attempting. If the
    // operator configured a challenge, this is the first place it belongs.
    if (turnstile?.enabled) {
      const passed = parsed.success
        && await verifyTurnstile(turnstile.secretKey, parsed.data.turnstileToken, turnstile.expectedHostname);
      if (!passed) return reply.code(403).send({ error: "turnstile_failed" });
    }
    // The code identifies the account by itself. Asking for a nickname as well
    // would add no security and would confirm to a stranger that the nickname
    // exists.
    if (!parsed.success) return reply.code(404).send({ error: "recovery_invalid" });
    const code = normaliseRecoveryCode(parsed.data.code);
    if (!code) return reply.code(404).send({ error: "recovery_invalid" });

    const row = one<{ id: string; user_id: string; used_at: string | null; replaced_at: string | null }>(
      database.sqlite,
      "select id, user_id, used_at, replaced_at from recovery_codes where token_hash = ?",
      [hashToken(code)]
    );
    // Unknown, spent and superseded answer the same way. Three answers would
    // tell somebody holding an old code that they had the right account.
    if (!row || row.used_at || row.replaced_at) {
      return reply.code(404).send({ error: "recovery_invalid" });
    }

    // `is_bot` is read alongside the row rather than through `UserRow`, which
    // does not carry it: a bot authenticates by ADR-0003 and must never be
    // reachable through a member's recovery path.
    const user = one<UserRow & { is_bot: number }>(
      database.sqlite,
      "select id, nickname, role, banned_at, is_bot from users where id = ?",
      [row.user_id]
    );
    if (!user || user.banned_at || user.is_bot === 1) {
      return reply.code(404).send({ error: "recovery_invalid" });
    }

    const now = new Date();
    let token = "";
    database.sqlite.exec("begin immediate");
    try {
      const live = one<{ id: string }>(
        database.sqlite,
        "select id from recovery_codes where id = ? and used_at is null and replaced_at is null",
        [row.id]
      );
      if (!live) {
        database.sqlite.exec("rollback");
        return reply.code(404).send({ error: "recovery_invalid" });
      }
      run(database.sqlite, "update recovery_codes set used_at = ? where id = ?", [now.toISOString(), row.id]);
      // Everything else goes. This is what makes theft loud rather than quiet.
      revokeSessionsForUser(database.sqlite, user.id, now.toISOString());
      token = createSession(database, user.id, request.headers["user-agent"], "recovery");
      audit(database, user.id, "recovery.used", user.id);
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    // Revocation is only honoured when a request authenticates again, so the
    // sockets of the Devices just signed out have to be dropped for the
    // sign-out to be immediate rather than eventual.
    realtime.disconnectUser(user.id);

    setSessionCookie(reply, token, secureCookies);
    // No replacement is minted here.
    //
    // A member who has just recovered is signed in and safe; handing them a new
    // secret in the same breath asks them to do a careful thing at the least
    // careful moment, and it is a code they did not ask for. The one they used
    // is spent either way, so the account is left with none and the settings
    // card says so plainly — making a new one is then a decision rather than a
    // step to click past.
    return reply.send({ user: publicUser({ ...user, bannedAt: user.banned_at }) });
  });
}
