/**
 * Who a caller is, and how long that answer stays true.
 *
 * A session is one row in `sessions` and one cookie in the browser. The raw
 * token is handed to the caller once and kept only as a hash, so a copy of the
 * database is not a pile of usable logins. Every transport that needs an
 * identity asks here — HTTP routes, the Socket.IO handshake, and the Music bot,
 * whose credential exchange mints a session of exactly this shape rather than a
 * parallel one of its own (see
 * `docs/adr/0003-music-bot-service-account-credentials.md`). One session model
 * means one place where "is this caller still allowed in" is answered, and one
 * revocation that closes every door at once.
 *
 * This module decides; `app.ts` composes. Registering `@fastify/cookie` and
 * choosing which routes exist stay with the composition root.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
// Side-effect type import: `request.cookies`, `reply.setCookie` and
// `reply.clearCookie` are declaration merges this plugin contributes.
import type {} from "@fastify/cookie";
import { all, one, run, type VoxlyDatabase } from "../db/database.js";
import { createOpaqueToken, hashToken } from "./tokens.js";

export const sessionCookieName = "voxly_session";
const sessionDays = 180;
const sessionRenewWindowDays = 30;

export interface AuthUser {
  id: string;
  nickname: string;
  role: "owner" | "member";
  bannedAt: string | null;
  /** A service account rather than a person; see `bots.ts`. */
  isBot: boolean;
  sessionId: string;
  sessionExpiresAt: string;
}

export interface SessionSummary extends Record<string, unknown> {
  id: string;
  userId: string;
  nickname: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
};

type SessionUserRow = {
  id: string;
  nickname: string;
  role: "owner" | "member";
  banned_at: string | null;
  is_bot: number;
};

export function createSession(database: VoxlyDatabase, userId: string) {
  const token = createOpaqueToken();
  const now = new Date();
  const expiresAt = sessionExpiry(now).toISOString();
  run(
    database.sqlite,
    "insert into sessions (id, token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), hashToken(token), userId, now.toISOString(), expiresAt]
  );
  database.save();
  return token;
}

function authenticate(sqlite: DatabaseSync, sessionToken: string | undefined): AuthUser | null {
  if (!sessionToken) {
    return null;
  }

  const session = one<SessionRow>(
    sqlite,
    "select id, user_id, expires_at, revoked_at from sessions where token_hash = ?",
    [hashToken(sessionToken)]
  );
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const user = one<SessionUserRow>(sqlite, "select id, nickname, role, banned_at, is_bot from users where id = ?", [
    session.user_id
  ]);
  if (!user || user.banned_at) {
    return null;
  }

  return {
    id: user.id,
    nickname: user.nickname,
    role: user.role,
    bannedAt: user.banned_at,
    isBot: user.is_bot === 1,
    sessionId: session.id,
    sessionExpiresAt: session.expires_at
  };
}

/**
 * The ordinary HTTP identity: authenticate, and extend the session while the
 * caller is still using it, so an active member is never signed out mid-use.
 */
export function authenticateHttp(
  database: VoxlyDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean
) {
  const sessionToken = request.cookies[sessionCookieName];
  const user = authenticate(database.sqlite, sessionToken);
  if (user && sessionToken) {
    renewSessionIfNeeded(database, user, sessionToken, reply, secureCookies);
  }
  return user;
}

/**
 * The same identity without the renewal, for a caller that is ending its
 * session rather than using it. Renewing a session on the way out would set a
 * fresh cookie the response is about to clear.
 */
export function authenticateWithoutRenewal(sqlite: DatabaseSync, request: FastifyRequest) {
  return authenticate(sqlite, request.cookies[sessionCookieName]);
}

/**
 * The Socket.IO handshake identity, read from the raw header. A handshake is
 * authenticated before any connection exists, so there is no Fastify request to
 * carry parsed cookies.
 */
export function authenticateSocket(sqlite: DatabaseSync, cookieHeader: string | undefined) {
  return authenticate(sqlite, parseCookieHeader(cookieHeader ?? "")[sessionCookieName]);
}

export function requireUser(
  database: VoxlyDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean
) {
  const user = authenticateHttp(database, request, reply, secureCookies);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return user;
}

export function requireOwner(
  database: VoxlyDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean
) {
  const user = requireUser(database, request, reply, secureCookies);
  if (!user) {
    return null;
  }
  if (user.role !== "owner") {
    reply.code(403).send({ error: "forbidden" });
    return null;
  }
  return user;
}

function renewSessionIfNeeded(
  database: VoxlyDatabase,
  user: AuthUser,
  sessionToken: string,
  reply: FastifyReply,
  secure: boolean
) {
  const currentExpiresAt = new Date(user.sessionExpiresAt);
  const renewalThreshold = Date.now() + sessionRenewWindowDays * 24 * 60 * 60 * 1000;
  if (currentExpiresAt.getTime() > renewalThreshold) {
    return;
  }

  const nextExpiresAt = sessionExpiry();
  run(database.sqlite, "update sessions set expires_at = ? where id = ?", [
    nextExpiresAt.toISOString(),
    user.sessionId
  ]);
  database.save();
  user.sessionExpiresAt = nextExpiresAt.toISOString();
  setSessionCookie(reply, sessionToken, secure, nextExpiresAt);
}

/**
 * Revoke one session. The write is left unsaved so a caller that revokes as
 * part of a larger action persists it once, with the audit line it belongs to.
 */
export function revokeSession(sqlite: DatabaseSync, sessionId: string, now = new Date().toISOString()) {
  run(sqlite, "update sessions set revoked_at = ? where id = ?", [now, sessionId]);
}

/** Revoke every live session an account holds; see `revokeSession` on saving. */
export function revokeSessionsForUser(sqlite: DatabaseSync, userId: string, now = new Date().toISOString()) {
  run(sqlite, "update sessions set revoked_at = ? where user_id = ? and revoked_at is null", [now, userId]);
}

/** Every session ever issued, newest first, for the owner's session console. */
export function allSessions(sqlite: DatabaseSync) {
  return all<SessionSummary>(
    sqlite,
    `select sessions.id, sessions.user_id as userId, users.nickname,
      sessions.created_at as createdAt, sessions.expires_at as expiresAt,
      sessions.revoked_at as revokedAt
     from sessions
     join users on users.id = sessions.user_id
     order by sessions.created_at desc`
  );
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, expires = sessionExpiry()) {
  reply.setCookie(sessionCookieName, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(sessionCookieName, { path: "/" });
}

function sessionExpiry(now = new Date()) {
  return new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);
}

/**
 * A malformed percent-escape must not be fatal.
 *
 * `decodeURIComponent` throws `URIError` on input like `%ZZ`, and this parser runs
 * inside the Socket.IO handshake middleware before any session exists. Socket.IO
 * invokes that middleware from an async caller, so a throw here surfaces as an
 * unhandled rejection and takes the process down — an unauthenticated remote kill.
 * `@fastify/cookie` on the HTTP path is lenient and yields the raw value, so
 * degrading the same way keeps the two paths reading a header identically.
 */
function safeDecodeCookieComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseCookieHeader(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [safeDecodeCookieComponent(part.slice(0, index)), safeDecodeCookieComponent(part.slice(index + 1))];
      })
  );
}
