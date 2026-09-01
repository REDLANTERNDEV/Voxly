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
import { audit } from "../audit.js";
import { all, one, run, type VoxlyDatabase } from "../db/database.js";
import { deviceLabel } from "./deviceLabel.js";
import { createOpaqueToken, hashToken } from "./tokens.js";

export const sessionCookieName = "voxly_session";

/**
 * The same cookie, with the prefix that makes the browser enforce what we
 * already ask for: `Secure`, `Path=/`, and no `Domain` — which together stop a
 * sibling subdomain from writing a session cookie our host will then read.
 *
 * Only usable over HTTPS, because the prefix *requires* `Secure`. A deployment
 * without `secureCookies` keeps the plain name; there is nothing to enforce
 * over plain HTTP anyway.
 *
 * Both names are read, always. That is what lets an existing deployment upgrade
 * without signing everybody out: a member arrives holding the old cookie,
 * authenticates on it, and the next write moves them to the prefixed one.
 */
export const hostSessionCookieName = `__Host-${sessionCookieName}`;

/** The name to write, given the transport. */
function cookieNameFor(secure: boolean) {
  return secure ? hostSessionCookieName : sessionCookieName;
}

/**
 * The token a request is carrying, under either name. The prefixed one wins:
 * during an upgrade a browser can hold both, and the prefixed one is the one a
 * subdomain could not have written.
 */
export function readSessionToken(cookies: Record<string, string | undefined>) {
  return cookies[hostSessionCookieName] ?? cookies[sessionCookieName];
}
const sessionDays = 180;
const sessionTouchIntervalMs = 15 * 60 * 1000;
const sessionRenewFloorMs = 7 * 24 * 60 * 60 * 1000;

/**
 * How long one token value is worth something before it is replaced. See
 * ADR-0015: the *session* stays long-lived, the *value* does not, and
 * conflating the two is what makes "fifteen minutes" look impossible for a
 * chat application.
 */
const tokenRotationMs = 15 * 60 * 1000;

/**
 * How long a retired value keeps working after it is replaced.
 *
 * Browsers fire requests in parallel and drop responses. Without this window,
 * ordinary concurrency and one lost `Set-Cookie` would both look exactly like
 * theft, and the cure would be worse than the disease.
 */
const tokenGraceMs = 2 * 60 * 1000;

/**
 * How long a retired value is remembered so that its reuse can still be
 * recognised. Past this it is simply unknown, and a stale cookie gets an
 * ordinary 401 rather than being treated as evidence.
 *
 * Matched to the idle timeout: a session that has not been used in thirty days
 * is dead anyway, so remembering its old tokens for longer answers a question
 * nobody can still ask.
 */
const tokenMemoryMs = 30 * 24 * 60 * 60 * 1000;


export interface AuthUser {
  id: string;
  nickname: string;
  role: "owner" | "member";
  bannedAt: string | null;
  /** A service account rather than a person; see `bots.ts`. */
  isBot: boolean;
  sessionId: string;
  sessionExpiresAt: string;
  sessionLastSeenAt: string | null;
  tokenIssuedAt: string | null;
  /** Authenticated on a retired value inside its grace window. */
  tokenSuperseded: boolean;
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
  last_seen_at: string | null;
  token_issued_at: string | null;
};

type SessionUserRow = {
  id: string;
  nickname: string;
  role: "owner" | "member";
  banned_at: string | null;
  is_bot: number;
};

/**
 * `userAgent` names the Device this session belongs to, for the member's own
 * list. It is reduced to a coarse label on the way in and the raw header is
 * never stored (`deviceLabel.ts`). A caller with no header still gets a session
 * — an unnamed Device a member can sign out beats one they cannot see.
 */
/**
 * How a Device arrived. Shown in the member's own list so that "was that me?"
 * has more to go on than a browser name — a Device that appeared by Recovery is
 * a very different event from one somebody linked while holding both.
 */
export type SessionOrigin = "invite" | "link" | "recovery";

export function createSession(
  database: VoxlyDatabase,
  userId: string,
  userAgent?: string,
  origin: SessionOrigin = "invite"
) {
  const token = createOpaqueToken();
  const now = new Date();
  const expiresAt = sessionExpiry(now).toISOString();
  run(
    database.sqlite,
    "insert into sessions (id, token_hash, user_id, created_at, expires_at, label, last_seen_at, token_issued_at, origin) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      crypto.randomUUID(),
      hashToken(token),
      userId,
      now.toISOString(),
      expiresAt,
      deviceLabel(userAgent),
      now.toISOString(),
      now.toISOString(),
      origin
    ]
  );
  database.save();
  return token;
}

/**
 * Why an authentication attempt failed, when the answer is worth acting on.
 *
 * `reused` is the only one that is not simply "no". It means a retired token
 * turned up after its grace window — two parties are holding the same cookie —
 * and the session has been revoked in response. Callers surface it so the
 * member is told why they were signed out rather than left guessing.
 */
export type AuthFailure = "" | "reused";

interface AuthFailureDetail {
  reason: AuthFailure;
  /** Whose session it was, so the caller can write the audit line for it. */
  userId: string;
}

let lastAuthFailure: AuthFailureDetail = { reason: "", userId: "" };

/**
 * Why the most recent `authenticate` answered null, and for whom.
 *
 * The audit row is written by the caller rather than here: `authenticate` is
 * handed a `DatabaseSync` and the audit log is a product guarantee that
 * `audit.ts` owns and that joins the caller's transaction (`AGENTS.md`). The
 * callers that need to report a reuse all hold a `VoxlyDatabase` already.
 */
export function takeAuthFailure(): AuthFailureDetail {
  const failure = lastAuthFailure;
  lastAuthFailure = { reason: "", userId: "" };
  return failure;
}

const sessionColumns =
  "id, user_id, expires_at, revoked_at, last_seen_at, token_issued_at";

function authenticate(sqlite: DatabaseSync, sessionToken: string | undefined): AuthUser | null {
  lastAuthFailure = { reason: "", userId: "" };
  if (!sessionToken) {
    return null;
  }

  const tokenHash = hashToken(sessionToken);
  let session = one<SessionRow>(
    sqlite,
    `select ${sessionColumns} from sessions where token_hash = ?`,
    [tokenHash]
  );
  // Not the current value. It may be one this session has already retired,
  // which is a different situation from an unknown token and is answered
  // differently.
  let superseded = false;
  if (!session) {
    const retired = one<{ session_id: string; superseded_at: string }>(
      sqlite,
      "select session_id, superseded_at from session_tokens where token_hash = ?",
      [tokenHash]
    );
    if (!retired) return null;
    const retiredFor = Date.now() - new Date(retired.superseded_at).getTime();
    session = one<SessionRow>(
      sqlite,
      `select ${sessionColumns} from sessions where id = ?`,
      [retired.session_id]
    );
    if (!session) return null;
    if (retiredFor > tokenGraceMs) {
      // Past the grace window, the only explanation left is that two parties
      // hold copies of this value. Revoking is the loud answer: it ends the
      // session for the thief *and* for the member, which is what makes the
      // theft visible instead of silent. See ADR-0015.
      if (!session.revoked_at) revokeSession(sqlite, session.id);
      lastAuthFailure = { reason: "reused", userId: session.user_id };
      return null;
    }
    superseded = true;
  }

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
    sessionExpiresAt: session.expires_at,
    sessionLastSeenAt: session.last_seen_at,
    tokenIssuedAt: session.token_issued_at,
    // A retired value inside its grace window authenticates but must not
    // rotate: rotating on it would retire the value the member is actually
    // holding and turn one lost response into a chain of them.
    tokenSuperseded: superseded
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
  const sessionToken = readSessionToken(request.cookies);
  const user = authenticate(database.sqlite, sessionToken);
  if (user && sessionToken) {
    // Renewal rides on the touch throttle: seen means still in use, and still
    // in use means the window starts again. The second clause is a floor rather
    // than a second policy — a session that somehow ended up close to expiry is
    // rescued on sight instead of waiting a quarter of an hour to be noticed.
    const touched = touchSession(database, user);
    if (touched || expiringSoon(user.sessionExpiresAt)) {
      renewSession(database, user, sessionToken, reply, secureCookies);
    }
    rotateTokenIfNeeded(database, user, sessionToken, reply, secureCookies);
  }
  return user;
}

/**
 * Replace the token value while leaving the session alone.
 *
 * This is not re-authentication and the member notices nothing: same row, same
 * id, same expiry, everything bound to the session unchanged. Only the value in
 * the cookie is new, and the old one is remembered so that its later use can be
 * recognised rather than merely refused. See ADR-0015.
 */
export function rotateTokenIfNeeded(
  database: VoxlyDatabase,
  user: AuthUser,
  sessionToken: string,
  reply: FastifyReply,
  secure: boolean,
  now = new Date()
) {
  // Rotating on a retired value would retire the one the member is actually
  // holding, turning a single lost response into a chain of them.
  if (user.tokenSuperseded) return false;
  const issuedAt = user.tokenIssuedAt ? new Date(user.tokenIssuedAt).getTime() : 0;
  // A session predating this feature has no issue time. Treat the first sight
  // of it as the clock starting rather than rotating every such request.
  if (!issuedAt) {
    run(database.sqlite, "update sessions set token_issued_at = ? where id = ? and token_issued_at is null", [
      now.toISOString(),
      user.sessionId
    ]);
    database.save();
    user.tokenIssuedAt = now.toISOString();
    return false;
  }
  if (now.getTime() - issuedAt < tokenRotationMs) return false;

  const nextToken = createOpaqueToken();
  const currentHash = hashToken(sessionToken);
  database.sqlite.exec("begin immediate");
  try {
    // Guarded on the value we were shown, so two parallel requests that both
    // decide to rotate produce one rotation rather than two — the loser's
    // update matches nothing and it simply keeps the cookie it has.
    const claimed = one<{ id: string }>(
      database.sqlite,
      "select id from sessions where id = ? and token_hash = ?",
      [user.sessionId, currentHash]
    );
    if (!claimed) {
      database.sqlite.exec("rollback");
      return false;
    }
    run(
      database.sqlite,
      "insert or replace into session_tokens (token_hash, session_id, superseded_at) values (?, ?, ?)",
      [currentHash, user.sessionId, now.toISOString()]
    );
    run(database.sqlite, "update sessions set token_hash = ?, token_issued_at = ? where id = ?", [
      hashToken(nextToken),
      now.toISOString(),
      user.sessionId
    ]);
    // Retired values are only useful while the reuse question can still be
    // asked. Cleaning up here keeps the table bounded without a scheduled job.
    run(database.sqlite, "delete from session_tokens where superseded_at < ?", [
      new Date(now.getTime() - tokenMemoryMs).toISOString()
    ]);
    database.sqlite.exec("commit");
  } catch (cause) {
    database.sqlite.exec("rollback");
    throw cause;
  }
  database.save();
  user.tokenIssuedAt = now.toISOString();
  setSessionCookie(reply, nextToken, secure, new Date(user.sessionExpiresAt));
  return true;
}

/**
 * When this Device was last used, for the member's own list.
 *
 * Throttled rather than written per request: a write per request is a write per
 * request, and "within the last quarter of an hour" is as precise as a list of
 * Devices ever needs to be. Renewal is not the place for it — that fires once
 * every few months, which would make the column useless.
 */
export function touchSession(database: VoxlyDatabase, user: AuthUser, now = new Date()) {
  const lastSeen = user.sessionLastSeenAt ? new Date(user.sessionLastSeenAt).getTime() : 0;
  if (Number.isFinite(lastSeen) && now.getTime() - lastSeen < sessionTouchIntervalMs) return false;
  const seenAt = now.toISOString();
  run(database.sqlite, "update sessions set last_seen_at = ? where id = ?", [seenAt, user.sessionId]);
  database.save();
  user.sessionLastSeenAt = seenAt;
  return true;
}

/**
 * The same identity without the renewal, for a caller that is ending its
 * session rather than using it. Renewing a session on the way out would set a
 * fresh cookie the response is about to clear.
 */
export function authenticateWithoutRenewal(sqlite: DatabaseSync, request: FastifyRequest) {
  return authenticate(sqlite, readSessionToken(request.cookies));
}

/**
 * The Socket.IO handshake identity, read from the raw header. A handshake is
 * authenticated before any connection exists, so there is no Fastify request to
 * carry parsed cookies.
 */
export function authenticateSocket(sqlite: DatabaseSync, cookieHeader: string | undefined) {
  return authenticate(sqlite, readSessionToken(parseCookieHeader(cookieHeader ?? "")));
}

export function requireUser(
  database: VoxlyDatabase,
  request: FastifyRequest,
  reply: FastifyReply,
  secureCookies: boolean
) {
  const user = authenticateHttp(database, request, reply, secureCookies);
  if (!user) {
    // A reused token is not merely "no". The member is being signed out
    // because their session was seen in two places, and they are owed that
    // sentence rather than a generic refusal (ADR-0015).
    const failure = takeAuthFailure();
    if (failure.reason === "reused") {
      reportSessionReuse(database, failure.userId);
      clearSessionCookie(reply);
    }
    reply.code(401).send({ error: failure.reason === "reused" ? "session_reused" : "unauthorized" });
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

/** Close enough to expiry that it is renewed regardless of the touch throttle. */
function expiringSoon(expiresAt: string, now = Date.now()) {
  const remaining = new Date(expiresAt).getTime() - now;
  return Number.isFinite(remaining) && remaining < sessionRenewFloorMs;
}

/**
 * Push the expiry back out to a full window, every time the member is seen.
 *
 * The session slides rather than counting down. Somebody who keeps using Voxly
 * is never signed out — which for a self-hosted group chat is the only sensible
 * behaviour, and the alternative is asking people to prove who they are again
 * for no event that happened.
 *
 * Sliding also makes expiry mean one thing instead of two: a session ends
 * because nobody has used it for the whole window, and there is no separate
 * idle rule that could disagree with the absolute one.
 *
 * Throttled to the same interval as `touchSession` — this rides on it, so an
 * active member costs one write per quarter hour rather than one per request.
 */
function renewSession(
  database: VoxlyDatabase,
  user: AuthUser,
  sessionToken: string,
  reply: FastifyReply,
  secure: boolean,
  now = new Date()
) {
  const nextExpiresAt = sessionExpiry(now);
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

/**
 * Revoke every live session but one. For a member clearing their account out
 * from a Device they are still sitting at — signing them out of the Device in
 * their hand as well would leave them with nothing to act from.
 */
export function revokeOtherSessionsForUser(
  sqlite: DatabaseSync,
  userId: string,
  keepSessionId: string,
  now = new Date().toISOString()
) {
  run(sqlite, "update sessions set revoked_at = ? where user_id = ? and id != ? and revoked_at is null", [
    now,
    userId,
    keepSessionId
  ]);
}

/** Revoke every live session an account holds; see `revokeSession` on saving. */
export function revokeSessionsForUser(sqlite: DatabaseSync, userId: string, now = new Date().toISOString()) {
  run(sqlite, "update sessions set revoked_at = ? where user_id = ? and revoked_at is null", [now, userId]);
}

/**
 * A member's own Devices: the sessions that could still be used, newest first.
 *
 * Revoked and expired rows are left out. The owner's console below deliberately
 * shows everything ever issued, because it answers a different question — this
 * one answers "what is signed in as me right now", and a list padded with dead
 * rows is one nobody reads.
 */
export function devicesForUser(sqlite: DatabaseSync, userId: string) {
  return all<DeviceRow>(
    sqlite,
    `select id, label, origin, created_at as createdAt, last_seen_at as lastSeenAt
     from sessions
     where user_id = ? and revoked_at is null and expires_at > ?
     order by coalesce(last_seen_at, created_at) desc`,
    [userId, new Date().toISOString()]
  );
}

export interface DeviceRow extends Record<string, unknown> {
  id: string;
  label: string | null;
  origin: SessionOrigin | null;
  createdAt: string;
  lastSeenAt: string | null;
}

/**
 * Revoke one of the caller's own Devices. Scoped to the owning account in the
 * statement itself rather than by a check beforehand, so a member cannot close
 * somebody else's session by guessing an id.
 */
export function revokeOwnDevice(database: VoxlyDatabase, userId: string, sessionId: string) {
  const session = one<{ id: string }>(
    database.sqlite,
    "select id from sessions where id = ? and user_id = ? and revoked_at is null",
    [sessionId, userId]
  );
  if (!session) return false;
  revokeSession(database.sqlite, sessionId);
  return true;
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

/**
 * The line an owner will want when a member says their account did something
 * they did not do. Written by whoever detected the reuse, with the database
 * handle `audit()` requires.
 */
export function reportSessionReuse(database: VoxlyDatabase, userId: string) {
  if (!userId) return;
  audit(database, null, "session.reused", userId);
  database.save();
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, expires = sessionExpiry()) {
  reply.setCookie(cookieNameFor(secure), token, {
    httpOnly: true,
    secure,
    // `lax` rather than `strict`: invite and claim links are navigated to from
    // outside, and `strict` would present those arrivals as signed out. It
    // already refuses the cross-site POST that CSRF needs.
    sameSite: "lax",
    path: "/",
    expires
  });
  // An upgrading deployment can leave a member holding the old name as well.
  // Clearing it here is what stops the two drifting apart.
  if (secure) reply.clearCookie(sessionCookieName, { path: "/" });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(sessionCookieName, { path: "/" });
  reply.clearCookie(hostSessionCookieName, { path: "/" });
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
