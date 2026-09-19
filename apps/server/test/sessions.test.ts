import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  allSessions,
  authenticateHttp,
  authenticateSocket,
  authenticateWithoutRenewal,
  clearSessionCookie,
  createSession,
  requireOwner,
  requireUser,
  revokeSession,
  revokeSessionsForUser,
  hostSessionCookieName,
  readSessionToken,
  sessionCookieName,
  setSessionCookie
} from "../src/auth/sessions.js";
import { hashToken } from "../src/auth/tokens.js";
import { one, openDatabase, run, type VoxlyDatabase } from "../src/db/database.js";

const day = 24 * 60 * 60 * 1000;

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  path?: string;
  expires?: Date;
}

/** Captures what a guard answered, and every cookie it wrote, without an HTTP round trip. */
function replyDouble() {
  const sent: { statusCode: number | null; body: unknown } = { statusCode: null, body: null };
  const cookies: { name: string; value: string | null; options: CookieOptions }[] = [];
  const reply = {
    code(statusCode: number) {
      sent.statusCode = statusCode;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
    setCookie(name: string, value: string, options: CookieOptions) {
      cookies.push({ name, value, options });
      return reply;
    },
    clearCookie(name: string, options: CookieOptions) {
      cookies.push({ name, value: null, options });
      return reply;
    }
  };
  return { reply: reply as unknown as FastifyReply, sent, cookies };
}

function requestDouble(cookies: Record<string, string>) {
  return { cookies } as unknown as FastifyRequest;
}

describe("sessions", () => {
  let database: VoxlyDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  interface AccountOptions {
    role?: "owner" | "member";
    bannedAt?: string;
    isBot?: boolean;
  }

  async function seed(accounts: Record<string, AccountOptions>): Promise<VoxlyDatabase> {
    const opened = await openDatabase(":memory:");
    database = opened;
    for (const [userId, options] of Object.entries(accounts)) {
      run(opened.sqlite, "insert into users (id, nickname, role, banned_at, is_bot) values (?, ?, ?, ?, ?)", [
        userId,
        userId,
        options.role ?? "member",
        options.bannedAt ?? null,
        options.isBot ? 1 : 0
      ]);
    }
    return opened;
  }

  /** A session row placed directly, so its expiry can be anywhere on the clock. */
  function placeSession(db: VoxlyDatabase, id: string, userId: string, expiresAt: Date, revokedAt: string | null = null) {
    const token = `token-${id}`;
    run(
      db.sqlite,
      "insert into sessions (id, token_hash, user_id, created_at, expires_at, revoked_at) values (?, ?, ?, ?, ?, ?)",
      [id, hashToken(token), userId, new Date().toISOString(), expiresAt.toISOString(), revokedAt]
    );
    return token;
  }

  /** Retires one value beyond the grace window and returns the current value. */
  function retireTokenPastGrace(db: VoxlyDatabase, token: string, confirmed = true) {
    const session = one<{ id: string }>(
      db.sqlite,
      "select id from sessions where token_hash = ?",
      [hashToken(token)]
    );
    assert.ok(session);
    const currentToken = `current-${session.id}`;
    run(
      db.sqlite,
      "insert into session_tokens (token_hash, session_id, superseded_at, replacement_seen_at) values (?, ?, ?, ?)",
      [
        hashToken(token),
        session.id,
        new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        confirmed ? new Date(Date.now() - 5 * 60 * 1000).toISOString() : null
      ]
    );
    run(db.sqlite, "update sessions set token_hash = ? where id = ?", [hashToken(currentToken), session.id]);
    return currentToken;
  }

  describe("creating one", () => {
    it("stores only the hash of the token it hands back", async () => {
      const db = await seed({ member: {} });

      const token = createSession(db, "member");

      const stored = one<{ token_hash: string; user_id: string }>(
        db.sqlite,
        "select token_hash, user_id from sessions"
      );
      assert.equal(stored?.user_id, "member");
      assert.equal(stored?.token_hash, hashToken(token));
      assert.notEqual(stored?.token_hash, token);
    });

    it("expires 180 days out", async () => {
      const db = await seed({ member: {} });

      createSession(db, "member");

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions");
      const lifetime = new Date(stored!.expires_at).getTime() - Date.now();
      assert.ok(Math.abs(lifetime - 180 * day) < 60_000, `expected ~180 days, got ${lifetime}ms`);
    });
  });

  describe("authenticating", () => {
    it("answers with the account behind a live session", async () => {
      const db = await seed({ member: {}, bot: { isBot: true } });
      const token = createSession(db, "member");
      const botToken = createSession(db, "bot");

      const user = authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: token }));
      assert.equal(user?.id, "member");
      assert.equal(user?.role, "member");
      assert.equal(user?.isBot, false);

      // The bot holds a session of exactly this shape; ADR-0003 keeps them one model.
      const bot = authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: botToken }));
      assert.equal(bot?.id, "bot");
      assert.equal(bot?.isBot, true);
    });

    it("refuses a missing, unknown, revoked or expired session", async () => {
      const db = await seed({ member: {} });
      const revoked = placeSession(db, "revoked", "member", new Date(Date.now() + day), new Date().toISOString());
      const expired = placeSession(db, "expired", "member", new Date(Date.now() - day));

      const attempts: Record<string, string>[] = [
        {},
        { [sessionCookieName]: "unknown" },
        { [sessionCookieName]: revoked },
        { [sessionCookieName]: expired }
      ];
      for (const cookies of attempts) {
        assert.equal(authenticateWithoutRenewal(db, requestDouble(cookies)), null);
      }
    });

    it("refuses a banned account that still holds a session", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      run(db.sqlite, "update users set banned_at = ? where id = ?", [new Date().toISOString(), "member"]);

      assert.equal(authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: token })), null);
    });

    it("returns reuse on that request without a module-global failure handoff", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      retireTokenPastGrace(db, token);
      const reusedReply = replyDouble();
      const unknownReply = replyDouble();

      const reused = authenticateHttp(
        db,
        requestDouble({ [sessionCookieName]: token }),
        reusedReply.reply,
        false
      );
      const unknown = authenticateHttp(
        db,
        requestDouble({ [sessionCookieName]: "unknown" }),
        unknownReply.reply,
        false
      );

      assert.deepEqual(reused, { ok: false, error: "session_reused" });
      assert.deepEqual(unknown, { ok: false, error: "unauthorized" });
      assert.deepEqual(
        reusedReply.cookies.map((cookie) => cookie.name),
        [sessionCookieName, hostSessionCookieName]
      );
      const auditCount = one<{ count: number }>(
        db.sqlite,
        "select count(*) as count from audit_events where action = 'session.reused' and target_user_id = ?",
        ["member"]
      );
      assert.equal(auditCount?.count, 1);
    });
  });

  describe("the handshake path", () => {
    it("reads the session out of a raw cookie header, past the cookies beside it", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");

      const user = authenticateSocket(db, `theme=dark; ${sessionCookieName}=${token}; consent`);

      assert.equal(user?.id, "member");
    });

    /**
     * The handshake runs before any session exists and Socket.IO calls it from an
     * async caller, so a throw here would be an unauthenticated remote kill.
     */
    it("degrades on a malformed percent-escape rather than throwing", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");

      assert.equal(authenticateSocket(db, "broken=%ZZ"), null);
      assert.equal(authenticateSocket(db, `broken=%ZZ; ${sessionCookieName}=${token}`)?.id, "member");
    });

    it("refuses a handshake carrying no cookies at all", async () => {
      const db = await seed({ member: {} });

      assert.equal(authenticateSocket(db, undefined), null);
      assert.equal(authenticateSocket(db, ""), null);
    });

    it("records reuse detected during a Socket.IO handshake", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      retireTokenPastGrace(db, token);

      const user = authenticateSocket(db, `${sessionCookieName}=${token}`);

      assert.equal(user, null);
      const session = one<{ revoked_at: string | null }>(db.sqlite, "select revoked_at from sessions");
      assert.ok(session?.revoked_at);
      const auditEvent = one<{ action: string; target_user_id: string | null }>(
        db.sqlite,
        "select action, target_user_id from audit_events where action = 'session.reused'"
      );
      assert.equal(auditEvent?.action, "session.reused");
      assert.equal(auditEvent?.target_user_id, "member");
    });

    it("does not call an unconfirmed rotation theft during a Socket.IO handshake", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      retireTokenPastGrace(db, token, false);

      const user = authenticateSocket(db, `${sessionCookieName}=${token}`);

      assert.equal(user?.id, "member");
      const session = one<{ revoked_at: string | null }>(db.sqlite, "select revoked_at from sessions");
      assert.equal(session?.revoked_at, null);
      const auditCount = one<{ count: number }>(
        db.sqlite,
        "select count(*) as count from audit_events where action = 'session.reused'"
      );
      assert.equal(auditCount?.count, 0);
    });

    it("lets a Socket.IO handshake confirm that a replacement was delivered", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      const currentToken = retireTokenPastGrace(db, token, false);

      assert.equal(authenticateSocket(db, `${sessionCookieName}=${currentToken}`)?.id, "member");
      const seen = one<{ replacement_seen_at: string | null }>(
        db.sqlite,
        "select replacement_seen_at from session_tokens where token_hash = ?",
        [hashToken(token)]
      );
      assert.ok(seen?.replacement_seen_at);

      run(
        db.sqlite,
        "update session_tokens set replacement_seen_at = ? where token_hash = ?",
        [new Date(Date.now() - 5 * 60 * 1000).toISOString(), hashToken(token)]
      );
      assert.equal(authenticateSocket(db, `${sessionCookieName}=${token}`), null);
    });
  });

  describe("renewal", () => {
    it("extends a session inside the renewal window and re-sets the cookie", async () => {
      const db = await seed({ member: {} });
      const token = placeSession(db, "ageing", "member", new Date(Date.now() + 10 * day));
      const { reply, cookies } = replyDouble();

      const authentication = authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), reply, true);

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions where id = ?", ["ageing"]);
      const lifetime = new Date(stored!.expires_at).getTime() - Date.now();
      assert.ok(Math.abs(lifetime - 180 * day) < 60_000, `expected ~180 days, got ${lifetime}ms`);
      // The answer the caller holds must not disagree with the row.
      assert.equal(authentication.ok && authentication.user.sessionExpiresAt, stored?.expires_at);
      // Secure transport, so the prefixed name — and the unprefixed one is
      // retired alongside it, which is how an upgrade moves members over.
      assert.deepEqual(
        cookies.map((entry) => entry.name),
        [hostSessionCookieName, sessionCookieName]
      );
      assert.equal(cookies[0]?.value, token);
      assert.equal(cookies[0]?.options.expires?.toISOString(), stored?.expires_at);
    });

    it("slides a session forward on use rather than counting it down", async () => {
      // Changed deliberately: the session used to sit still until it was near
      // expiry. It now renews whenever the member is seen, so somebody who
      // keeps using Voxly is never signed out — the only sensible behaviour for
      // a self-hosted group, and the alternative asks people to prove who they
      // are again for no event that happened.
      const db = await seed({ member: {} });
      const expiresAt = new Date(Date.now() + 90 * day);
      const token = placeSession(db, "fresh", "member", expiresAt);
      const { reply, cookies } = replyDouble();

      authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), reply, true);

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions where id = ?", ["fresh"]);
      const remaining = new Date(stored!.expires_at).getTime() - Date.now();
      assert.ok(remaining > 170 * day, `expected a full window, got ${Math.round(remaining / day)} days`);
      assert.ok(cookies.length > 0, "the browser was not told the new expiry");
    });

    it("does not write on every request while sliding", async () => {
      // Renewal rides on the touch throttle, so an active member costs one
      // write per quarter hour rather than one per request.
      const db = await seed({ member: {} });
      const token = placeSession(db, "busy", "member", new Date(Date.now() + 90 * day));
      authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), replyDouble().reply, true);

      const { reply, cookies } = replyDouble();
      authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), reply, true);

      assert.deepEqual(cookies, []);
    });

    it("does not renew for a caller that is ending its session", async () => {
      const db = await seed({ member: {} });
      const expiresAt = new Date(Date.now() + 10 * day);
      const token = placeSession(db, "ageing", "member", expiresAt);

      authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: token }));

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions where id = ?", ["ageing"]);
      assert.equal(stored?.expires_at, expiresAt.toISOString());
    });
  });

  describe("the guards routes call", () => {
    it("passes an active member through and refuses everyone else with 401", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");

      const allowed = replyDouble();
      assert.equal(requireUser(db, requestDouble({ [sessionCookieName]: token }), allowed.reply, true)?.id, "member");
      assert.equal(allowed.sent.statusCode, null);

      const refused = replyDouble();
      assert.equal(requireUser(db, requestDouble({}), refused.reply, true), null);
      assert.equal(refused.sent.statusCode, 401);
      assert.deepEqual(refused.sent.body, { error: "unauthorized" });
    });

    it("tells an ordinary member apart from the owner with 403, and an anonymous caller with 401", async () => {
      const db = await seed({ owner: { role: "owner" }, member: {} });
      const ownerToken = createSession(db, "owner");
      const memberToken = createSession(db, "member");

      const allowed = replyDouble();
      assert.equal(requireOwner(db, requestDouble({ [sessionCookieName]: ownerToken }), allowed.reply, true)?.id, "owner");
      assert.equal(allowed.sent.statusCode, null);

      const forbidden = replyDouble();
      assert.equal(requireOwner(db, requestDouble({ [sessionCookieName]: memberToken }), forbidden.reply, true), null);
      assert.equal(forbidden.sent.statusCode, 403);
      assert.deepEqual(forbidden.sent.body, { error: "forbidden" });

      const unauthorized = replyDouble();
      assert.equal(requireOwner(db, requestDouble({}), unauthorized.reply, true), null);
      assert.equal(unauthorized.sent.statusCode, 401);
    });
  });

  describe("revoking", () => {
    it("closes one session and leaves the account's others open", async () => {
      const db = await seed({ member: {} });
      const kept = createSession(db, "member");
      const dropped = createSession(db, "member");
      const droppedId = one<{ id: string }>(db.sqlite, "select id from sessions where token_hash = ?", [
        hashToken(dropped)
      ]);

      revokeSession(db.sqlite, droppedId!.id);

      assert.equal(authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: dropped })), null);
      assert.equal(authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: kept }))?.id, "member");
    });

    it("closes every live session an account holds, and nobody else's", async () => {
      const db = await seed({ member: {}, other: {} });
      const first = createSession(db, "member");
      const second = createSession(db, "member");
      const bystander = createSession(db, "other");

      revokeSessionsForUser(db.sqlite, "member");

      for (const token of [first, second]) {
        assert.equal(authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: token })), null);
      }
      assert.equal(authenticateWithoutRenewal(db, requestDouble({ [sessionCookieName]: bystander }))?.id, "other");
    });

    it("keeps the revoked row for the owner's console rather than deleting it", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      const id = one<{ id: string }>(db.sqlite, "select id from sessions where token_hash = ?", [hashToken(token)]);
      const now = "2026-01-01T00:00:00.000Z";

      revokeSession(db.sqlite, id!.id, now);

      const sessions = allSessions(db.sqlite);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.userId, "member");
      assert.equal(sessions[0]?.nickname, "member");
      assert.equal(sessions[0]?.revokedAt, now);
      // The raw token is never part of what the console reads.
      assert.equal(JSON.stringify(sessions).includes(token), false);
    });
  });

  describe("the cookie", () => {
    it("is http-only, lax and path-wide, and follows the deployment's transport", async () => {
      for (const secure of [true, false]) {
        const { reply, cookies } = replyDouble();

        setSessionCookie(reply, "token", secure);

        // Over HTTPS the name carries the `__Host-` prefix, which makes the
        // browser enforce what we already ask for and stops a sibling subdomain
        // writing a session cookie this host would then read. The prefix
        // *requires* Secure, so plain HTTP keeps the plain name.
        assert.equal(cookies[0]?.name, secure ? hostSessionCookieName : sessionCookieName);
        assert.equal(cookies[0]?.value, "token");
        assert.deepEqual(
          { ...cookies[0]?.options, expires: undefined },
          { httpOnly: true, secure, sameSite: "lax", path: "/", expires: undefined }
        );
      }
    });

    it("retires the unprefixed name once it is writing the prefixed one", () => {
      // An upgrading deployment leaves members holding the old name too. Both
      // would be read, and two copies of one credential is how they drift apart.
      const { reply, cookies } = replyDouble();

      setSessionCookie(reply, "token", true);

      assert.deepEqual(cookies[1], { name: sessionCookieName, value: null, options: { path: "/" } });
    });

    it("prefers the prefixed cookie when a browser is holding both", () => {
      // Mid-upgrade a browser can carry both. The prefixed one wins because it
      // is the one a subdomain could not have written.
      assert.equal(
        readSessionToken({ [sessionCookieName]: "old", [hostSessionCookieName]: "new" }),
        "new"
      );
      assert.equal(readSessionToken({ [sessionCookieName]: "old" }), "old");
      assert.equal(readSessionToken({}), undefined);
    });

    it("is cleared across the whole site, so no stale copy survives on a sub-path", () => {
      const { reply, cookies } = replyDouble();

      clearSessionCookie(reply);

      // Both names, or an upgrade would leave the old one behind on sign-out.
      assert.deepEqual(cookies, [
        { name: sessionCookieName, value: null, options: { path: "/" } },
        { name: hostSessionCookieName, value: null, options: { path: "/" } }
      ]);
    });
  });
});
