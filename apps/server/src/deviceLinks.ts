/**
 * Bringing a second Device onto an account, with the member's approval.
 *
 * The flow has four moments and they are deliberately separate rows in time:
 * a signed-in Device *mints* a Link code, the arriving Device *claims* it, the
 * minting Device *approves* it, and only then does the arriving Device
 * *collect* a session. Nothing is minted at claim time.
 *
 * That middle step is the security design, not ceremony. Voxly's members share
 * their screens constantly, so a code that is sufficient on its own is a code
 * that can be read off a stream. Ninety seconds narrows that window; it does
 * not close it. Approval on the Device that minted the code — which is, on this
 * path, in the member's hand by definition — closes it: a leaked code is no
 * longer enough to take an account. See ADR-0014.
 *
 * Two secrets are involved and only one of them is ever seen by a person. The
 * Link code is short because somebody types it. The claim token handed back to
 * the arriving Device is full entropy and never displayed — it exists so that
 * whoever *else* saw the code cannot poll for the session it eventually mints.
 */

import { z } from "zod";
import { audit } from "./audit.js";
import { deviceLabel } from "./auth/deviceLabel.js";
import {
  createConfirmationNumber,
  createLinkCode,
  formatLinkCode,
  normaliseLinkCode
} from "./auth/linkCode.js";
import { createSession, requireUser, setSessionCookie } from "./auth/sessions.js";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { one, run, type VoxlyDatabase } from "./db/database.js";
import { authenticatedWriteLimit, type RouteContext } from "./http.js";
import { verifyTurnstile } from "./turnstile.js";
import { publicUser, type UserRow } from "./users.js";

/**
 * How long a code is worth something before anybody claims it. Short enough
 * that a code caught in a screen recording is dead before anyone watches it
 * back, long enough to read ten characters onto a phone.
 */
const claimWindowSeconds = 90;

/**
 * And how long the member then has to approve. Measured from the claim rather
 * than the mint, because looking at the other Device and reading a number off
 * it is a second task and should not inherit whatever is left of the first
 * window. There is still only one `expires_at`: claiming moves it.
 */
const approvalWindowSeconds = 120;

/**
 * Claiming and collecting are unauthenticated by necessity — the Device asking
 * has no session yet, which is the entire point. Tighter than
 * `unauthenticatedWriteLimit` because these are the two endpoints where
 * guessing would be the attack.
 */
const linkRedeemLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

interface LinkRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  expires_at: string;
  consumed_at: string | null;
  claimed_at: string | null;
  claim_label: string | null;
  confirmation: string | null;
  approved_at: string | null;
  refused_at: string | null;
}

const linkColumns =
  "id, user_id, expires_at, consumed_at, claimed_at, claim_label, confirmation, approved_at, refused_at";

function isExpired(row: { expires_at: string }, now = Date.now()) {
  return new Date(row.expires_at).getTime() <= now;
}

/**
 * One outstanding Link code per member.
 *
 * A member who opens the dialog twice has changed their mind, not asked for two
 * ways in. Retiring the previous code on every mint means the number of live
 * codes for an account is always zero or one, which is a far easier thing to
 * reason about than a set with a cleanup policy.
 */
function retireOutstandingLinks(database: VoxlyDatabase, userId: string, now: string) {
  run(
    database.sqlite,
    // `approved_at is null` matters: an approved link is no longer an
    // outstanding code, it is a session the arriving Device has not picked up
    // yet. Retiring it revokes an approval the member already gave, and the
    // Device that was seconds from collecting is told its code expired.
    "update device_links set consumed_at = ? where user_id = ? and consumed_at is null and approved_at is null",
    [now, userId]
  );
}

export function registerDeviceLinkRoutes({ fastify, database, secureCookies, turnstile }: RouteContext) {
  fastify.post("/api/devices/links", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    if (user.isBot) return reply.code(409).send({ error: "bot_has_no_devices" });

    const code = createLinkCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + claimWindowSeconds * 1000).toISOString();
    const linkId = crypto.randomUUID();
    database.sqlite.exec("begin immediate");
    try {
      retireOutstandingLinks(database, user.id, now.toISOString());
      run(
        database.sqlite,
        "insert into device_links (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
        [linkId, hashToken(code), user.id, now.toISOString(), expiresAt]
      );
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();

    // The formatted form is what gets displayed and read aloud; the value the
    // member types is normalised back to this on the way in.
    //
    // `linkId` is not a secret — only the code is — and it exists so the caller
    // can retire *the code it created* rather than "whatever is outstanding".
    // A client that mints twice in quick succession (React's development
    // double-mount does exactly this) would otherwise have its second, live
    // code retired by the first one's cleanup, and the member would be told
    // their perfectly good code had expired.
    // `expiresInSeconds` alongside the absolute time, because a member whose
    // clock is wrong would otherwise be shown a countdown that is wrong with
    // it — "expired" on a code that is fine, or minutes on one that is not.
    // The absolute value stays authoritative on the server; the number is only
    // for the counter on screen.
    return reply.code(201).send({
      code: formatLinkCode(code),
      expiresAt,
      expiresInSeconds: claimWindowSeconds,
      linkId
    });
  });

  /**
   * The dialog closed. A code nobody is watching should not stay alive.
   *
   * Scoped to the one link the caller names, never to "everything outstanding":
   * see the note on `linkId` above for the race that costs.
   */
  fastify.delete("/api/devices/links/:linkId", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const parsed = z.object({ linkId: z.string().min(1).max(64) }).safeParse(request.params);
    if (!parsed.success) return reply.send({ ok: true });
    run(
      database.sqlite,
      // Closing the dialog means "stop showing this code", not "take back the
      // approval I just gave". This is the bug the QR path exposed: scanning is
      // quick enough that the member reaches Done before the arriving Device's
      // next poll, and the cleanup beat the collect.
      "update device_links set consumed_at = ? where id = ? and user_id = ? and consumed_at is null and approved_at is null",
      [new Date().toISOString(), parsed.data.linkId, user.id]
    );
    database.save();
    return reply.send({ ok: true });
  });

  /** What the minting Device polls while its code is on screen. */
  fastify.get("/api/devices/links/waiting", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const link = one<LinkRow>(
      database.sqlite,
      `select ${linkColumns} from device_links
       where user_id = ? and consumed_at is null and claimed_at is not null
         and approved_at is null and refused_at is null
       order by claimed_at desc limit 1`,
      [user.id]
    );
    if (!link || isExpired(link)) return reply.send({ waiting: null });
    return reply.send({
      waiting: {
        confirmation: link.confirmation,
        label: link.claim_label,
        expiresAt: link.expires_at
      }
    });
  });

  fastify.post("/api/devices/links/approve", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const parsed = z.object({ approve: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });

    const link = one<LinkRow>(
      database.sqlite,
      `select ${linkColumns} from device_links
       where user_id = ? and consumed_at is null and claimed_at is not null
         and approved_at is null and refused_at is null
       order by claimed_at desc limit 1`,
      [user.id]
    );
    if (!link || isExpired(link)) return reply.code(404).send({ error: "link_invalid" });

    const now = new Date().toISOString();
    // Refusing rejects *that claim*, not the code.
    //
    // It used to consume the link, so a member who refused by mistake — or
    // refused the wrong thing — was left holding a code with a minute still on
    // it that no longer worked, and no way to tell why. Releasing the claim
    // lets them simply type it again; the refused claim token is answered
    // `refused` until somebody claims afresh, and any new claim needs its own
    // approval regardless. The deadline is not extended again, so a code cannot
    // be kept alive by claiming and refusing in a loop.
    run(
      database.sqlite,
      parsed.data.approve
        ? "update device_links set approved_at = ? where id = ?"
        : "update device_links set refused_at = ? where id = ?",
      [now, link.id]
    );
    if (parsed.data.approve) audit(database, user.id, "device.linked", user.id);
    database.save();
    return reply.send({ ok: true });
  });

  /**
   * The arriving Device presents the code. It is told what number to display
   * and given a claim token — and pointedly not a session.
   */
  fastify.post("/api/devices/links/claim", { config: linkRedeemLimit }, async (request, reply) => {
    const parsed = z
      .object({ code: z.string().min(1).max(64), turnstileToken: z.string().optional() })
      .safeParse(request.body);
    // The operator's challenge, where they configured one. This endpoint takes
    // a guessable-in-principle secret from a caller with no session, which is
    // the same shape as invite acceptance and deserves the same door.
    if (turnstile?.enabled) {
      const passed = parsed.success
        && await verifyTurnstile(turnstile.secretKey, parsed.data.turnstileToken, turnstile.expectedHostname);
      if (!passed) return reply.code(403).send({ error: "turnstile_failed" });
    }
    // Unknown, expired, already claimed and malformed all answer the same way.
    // Three answers would be an oracle telling a guesser which half was right.
    if (!parsed.success) return reply.code(404).send({ error: "link_invalid" });
    const code = normaliseLinkCode(parsed.data.code);
    if (!code) return reply.code(404).send({ error: "link_invalid" });

    const link = one<LinkRow>(
      database.sqlite,
      `select ${linkColumns} from device_links where token_hash = ?`,
      [hashToken(code)]
    );
    // A refused claim releases the code: `refused_at` set means the last device
    // to ask was turned away, and this one may ask for itself.
    const claimable = link && !link.consumed_at && (!link.claimed_at || link.refused_at) && !isExpired(link);
    if (!claimable) {
      return reply.code(404).send({ error: "link_invalid" });
    }

    const claimToken = createOpaqueToken();
    const confirmation = createConfirmationNumber();
    const now = new Date();
    // The first claim moves the deadline — reading a number off the other Device
    // is a second task and should not inherit what is left of the first window.
    // A claim after a refusal does not, or the code could be kept alive
    // indefinitely by claiming and refusing in turn.
    const firstClaim = !link.claimed_at;
    const nextExpiry = firstClaim
      ? new Date(now.getTime() + approvalWindowSeconds * 1000).toISOString()
      : link.expires_at;
    run(
      database.sqlite,
      `update device_links
       set claim_token_hash = ?, claimed_at = ?, claim_label = ?, confirmation = ?,
           refused_at = null, expires_at = ?
       where id = ? and consumed_at is null`,
      [
        hashToken(claimToken),
        now.toISOString(),
        deviceLabel(request.headers["user-agent"]),
        confirmation,
        nextExpiry,
        link.id
      ]
    );
    database.save();
    return reply.send({ claimToken, confirmation });
  });

  /**
   * The arriving Device asks whether it was approved. Only the holder of the
   * claim token may ask — whoever else read the code off a screen cannot.
   */
  fastify.post("/api/devices/links/collect", { config: linkRedeemLimit }, async (request, reply) => {
    const parsed = z.object({ claimToken: z.string().min(1).max(128) }).safeParse(request.body);
    if (!parsed.success) return reply.code(404).send({ error: "link_invalid" });

    const link = one<LinkRow>(
      database.sqlite,
      `select ${linkColumns} from device_links where claim_token_hash = ?`,
      [hashToken(parsed.data.claimToken)]
    );
    if (!link) return reply.code(404).send({ error: "link_invalid" });
    if (link.refused_at) return reply.send({ status: "refused" });
    if (link.consumed_at) return reply.send({ status: "expired" });
    if (isExpired(link)) return reply.send({ status: "expired" });
    if (!link.approved_at) return reply.send({ status: "pending" });

    const user = one<UserRow>(
      database.sqlite,
      "select id, nickname, role, banned_at, is_bot from users where id = ?",
      [link.user_id]
    );
    if (!user || user.banned_at) return reply.code(404).send({ error: "link_invalid" });

    // Consume inside the same transaction that mints, so an approved link can
    // never hand out two sessions.
    database.sqlite.exec("begin immediate");
    let token = "";
    try {
      const claimed = one<{ id: string }>(
        database.sqlite,
        "select id from device_links where id = ? and consumed_at is null",
        [link.id]
      );
      if (!claimed) {
        database.sqlite.exec("rollback");
        return reply.send({ status: "expired" });
      }
      run(database.sqlite, "update device_links set consumed_at = ? where id = ?", [
        new Date().toISOString(),
        link.id
      ]);
      token = createSession(database, user.id, request.headers["user-agent"], "link");
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    setSessionCookie(reply, token, secureCookies);
    return reply.send({ status: "approved", user: publicUser({ ...user, bannedAt: user.banned_at }) });
  });
}
