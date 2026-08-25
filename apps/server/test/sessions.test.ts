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

      const user = authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: token }));
      assert.equal(user?.id, "member");
      assert.equal(user?.role, "member");
      assert.equal(user?.isBot, false);

      // The bot holds a session of exactly this shape; ADR-0003 keeps them one model.
      const bot = authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: botToken }));
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
        assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble(cookies)), null);
      }
    });

    it("refuses a banned account that still holds a session", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");
      run(db.sqlite, "update users set banned_at = ? where id = ?", [new Date().toISOString(), "member"]);

      assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: token })), null);
    });
  });

  describe("the handshake path", () => {
    it("reads the session out of a raw cookie header, past the cookies beside it", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");

      const user = authenticateSocket(db.sqlite, `theme=dark; ${sessionCookieName}=${token}; consent`);

      assert.equal(user?.id, "member");
    });

    /**
     * The handshake runs before any session exists and Socket.IO calls it from an
     * async caller, so a throw here would be an unauthenticated remote kill.
     */
    it("degrades on a malformed percent-escape rather than throwing", async () => {
      const db = await seed({ member: {} });
      const token = createSession(db, "member");

      assert.equal(authenticateSocket(db.sqlite, "broken=%ZZ"), null);
      assert.equal(authenticateSocket(db.sqlite, `broken=%ZZ; ${sessionCookieName}=${token}`)?.id, "member");
    });

    it("refuses a handshake carrying no cookies at all", async () => {
      const db = await seed({ member: {} });

      assert.equal(authenticateSocket(db.sqlite, undefined), null);
      assert.equal(authenticateSocket(db.sqlite, ""), null);
    });
  });

  describe("renewal", () => {
    it("extends a session inside the renewal window and re-sets the cookie", async () => {
      const db = await seed({ member: {} });
      const token = placeSession(db, "ageing", "member", new Date(Date.now() + 10 * day));
      const { reply, cookies } = replyDouble();

      const user = authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), reply, true);

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions where id = ?", ["ageing"]);
      const lifetime = new Date(stored!.expires_at).getTime() - Date.now();
      assert.ok(Math.abs(lifetime - 180 * day) < 60_000, `expected ~180 days, got ${lifetime}ms`);
      // The answer the caller holds must not disagree with the row.
      assert.equal(user?.sessionExpiresAt, stored?.expires_at);
      assert.deepEqual(cookies.map((entry) => entry.name), [sessionCookieName]);
      assert.equal(cookies[0]?.value, token);
      assert.equal(cookies[0]?.options.expires?.toISOString(), stored?.expires_at);
    });

    it("leaves a session that is nowhere near expiry alone", async () => {
      const db = await seed({ member: {} });
      const expiresAt = new Date(Date.now() + 90 * day);
      const token = placeSession(db, "fresh", "member", expiresAt);
      const { reply, cookies } = replyDouble();

      authenticateHttp(db, requestDouble({ [sessionCookieName]: token }), reply, true);

      const stored = one<{ expires_at: string }>(db.sqlite, "select expires_at from sessions where id = ?", ["fresh"]);
      assert.equal(stored?.expires_at, expiresAt.toISOString());
      assert.deepEqual(cookies, []);
    });

    it("does not renew for a caller that is ending its session", async () => {
      const db = await seed({ member: {} });
      const expiresAt = new Date(Date.now() + 10 * day);
      const token = placeSession(db, "ageing", "member", expiresAt);

      authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: token }));

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

      assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: dropped })), null);
      assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: kept }))?.id, "member");
    });

    it("closes every live session an account holds, and nobody else's", async () => {
      const db = await seed({ member: {}, other: {} });
      const first = createSession(db, "member");
      const second = createSession(db, "member");
      const bystander = createSession(db, "other");

      revokeSessionsForUser(db.sqlite, "member");

      for (const token of [first, second]) {
        assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: token })), null);
      }
      assert.equal(authenticateWithoutRenewal(db.sqlite, requestDouble({ [sessionCookieName]: bystander }))?.id, "other");
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

        assert.equal(cookies[0]?.name, sessionCookieName);
        assert.equal(cookies[0]?.value, "token");
        assert.deepEqual(
          { ...cookies[0]?.options, expires: undefined },
          { httpOnly: true, secure, sameSite: "lax", path: "/", expires: undefined }
        );
      }
    });

    it("is cleared across the whole site, so no stale copy survives on a sub-path", () => {
      const { reply, cookies } = replyDouble();

      clearSessionCookie(reply);

      assert.deepEqual(cookies, [{ name: sessionCookieName, value: null, options: { path: "/" } }]);
    });
  });
});
