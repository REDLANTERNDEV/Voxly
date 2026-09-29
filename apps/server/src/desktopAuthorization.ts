/** Browser approval for a desktop Device without moving a session token through the shell. */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "./audit.js";
import { createConfirmationNumber } from "./auth/linkCode.js";
import { deviceLabel } from "./auth/deviceLabel.js";
import { createSession, requireUser, setSessionCookie } from "./auth/sessions.js";
import { createOpaqueToken, hashToken } from "./auth/tokens.js";
import { one, run } from "./db/database.js";
import { authenticatedWriteLimit, unauthenticatedWriteLimit, type RouteContext } from "./http.js";
import { publicUser, type UserRow } from "./users.js";

const lifetimeMs = 90_000;
const idSchema = z.object({ id: z.string().uuid() });
const secretSchema = z.object({ secret: z.string().min(32).max(128) });
const decisionSchema = z.object({ approve: z.boolean() });
const collectLimit = { rateLimit: { max: 40, timeWindow: "1 minute" } };

interface AuthorizationRow extends Record<string, unknown> {
  id: string;
  secret_hash: string;
  origin: string;
  label: string;
  confirmation: string;
  expires_at: string;
  approved_user_id: string | null;
  approved_session_id: string | null;
  approved_at: string | null;
  refused_at: string | null;
  cancelled_at: string | null;
  consumed_at: string | null;
}

const columns = "id, secret_hash, origin, label, confirmation, expires_at, approved_user_id, approved_session_id, approved_at, refused_at, cancelled_at, consumed_at";

function requestOrigin(request: FastifyRequest) {
  const value = request.headers.origin;
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (value !== url.origin || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) return null;
    return value;
  } catch {
    return null;
  }
}

function live(row: AuthorizationRow) {
  return !row.consumed_at && !row.cancelled_at && new Date(row.expires_at).getTime() > Date.now();
}

export function registerDesktopAuthorizationRoutes({ fastify, database, secureCookies }: RouteContext) {
  // No browser session exists on the arriving Device. The private secret stays
  // in its webview memory; the public id is safe to open in the browser.
  fastify.post("/api/devices/desktop-authorizations", { config: unauthenticatedWriteLimit }, async (request, reply) => {
    const origin = requestOrigin(request);
    if (!origin) return reply.code(400).send({ error: "invalid_request" });
    const id = crypto.randomUUID();
    const secret = createOpaqueToken();
    const confirmation = createConfirmationNumber();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + lifetimeMs).toISOString();
    // Unauthenticated requests must not grow this short-lived table forever.
    run(database.sqlite, "delete from desktop_authorizations where expires_at < ?", [new Date(now.getTime() - 60 * 60 * 1000).toISOString()]);
    run(database.sqlite,
      "insert into desktop_authorizations (id, secret_hash, origin, label, confirmation, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)",
      [id, hashToken(secret), origin, deviceLabel(request.headers["user-agent"]), confirmation, now.toISOString(), expiresAt]
    );
    database.save();
    return reply.code(201).send({ id, secret, confirmation, expiresInSeconds: lifetimeMs / 1000 });
  });

  fastify.get("/api/devices/desktop-authorizations/:id", async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(404).send({ error: "authorization_invalid" });
    const row = one<AuthorizationRow>(database.sqlite, `select ${columns} from desktop_authorizations where id = ?`, [parsed.data.id]);
    if (!row || !live(row) || row.approved_at || row.refused_at) return reply.code(404).send({ error: "authorization_invalid" });
    return reply.send({ confirmation: row.confirmation, label: row.label, origin: row.origin, expiresAt: row.expires_at });
  });

  fastify.post("/api/devices/desktop-authorizations/:id/decision", { config: authenticatedWriteLimit }, async (request, reply) => {
    const user = requireUser(database, request, reply, secureCookies);
    if (!user) return;
    if (user.isBot) return reply.code(404).send({ error: "authorization_invalid" });
    const params = idSchema.safeParse(request.params);
    const body = decisionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(404).send({ error: "authorization_invalid" });
    const row = one<AuthorizationRow>(database.sqlite, `select ${columns} from desktop_authorizations where id = ?`, [params.data.id]);
    if (!row || !live(row) || row.approved_at || row.refused_at || requestOrigin(request) !== row.origin) {
      return reply.code(404).send({ error: "authorization_invalid" });
    }
    const now = new Date().toISOString();
    database.sqlite.exec("begin immediate");
    try {
      const result = body.data.approve
        ? database.sqlite.prepare(`update desktop_authorizations set approved_user_id = ?, approved_session_id = ?, approved_at = ?
            where id = ? and approved_at is null and refused_at is null and cancelled_at is null and consumed_at is null and expires_at > ?`)
          .run(user.id, user.sessionId, now, row.id, now)
        : database.sqlite.prepare(`update desktop_authorizations set refused_at = ?
            where id = ? and approved_at is null and refused_at is null and cancelled_at is null and consumed_at is null and expires_at > ?`)
          .run(now, row.id, now);
      if (result.changes !== 1) {
        database.sqlite.exec("rollback");
        return reply.code(404).send({ error: "authorization_invalid" });
      }
      database.sqlite.exec("commit");
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
    database.save();
    return reply.send({ ok: true });
  });

  fastify.post("/api/devices/desktop-authorizations/:id/collect", { config: collectLimit }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const body = secretSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(404).send({ error: "authorization_invalid" });
    const row = one<AuthorizationRow>(database.sqlite,
      `select ${columns} from desktop_authorizations where id = ? and secret_hash = ?`,
      [params.data.id, hashToken(body.data.secret)]
    );
    if (!row || requestOrigin(request) !== row.origin) return reply.code(404).send({ error: "authorization_invalid" });
    if (row.refused_at) return reply.send({ status: "refused" });
    if (!live(row)) return reply.send({ status: "expired" });
    if (!row.approved_at) return reply.send({ status: "pending" });

    // Recheck approval and its browser session in the same transaction that
    // consumes the request and mints a Device session. A revoked approving
    // Device or Deleted account can no longer authorize collection.
    database.sqlite.exec("begin immediate");
    try {
      const current = one<AuthorizationRow>(database.sqlite,
        `select ${columns} from desktop_authorizations where id = ? and secret_hash = ?`,
        [row.id, row.secret_hash]
      );
      if (!current || !live(current) || !current.approved_at || !current.approved_user_id || !current.approved_session_id) {
        database.sqlite.exec("rollback");
        return reply.send({ status: "expired" });
      }
      const session = one<{ id: string }>(database.sqlite,
        "select id from sessions where id = ? and user_id = ? and revoked_at is null and expires_at > ?",
        [current.approved_session_id, current.approved_user_id, new Date().toISOString()]
      );
      const user = one<UserRow & { deleted_at: string | null; is_bot: number }>(database.sqlite,
        "select id, nickname, role, banned_at, is_bot, deleted_at from users where id = ?",
        [current.approved_user_id]
      );
      if (!session || !user || user.banned_at || user.deleted_at || user.is_bot) {
        database.sqlite.exec("rollback");
        return reply.send({ status: "expired" });
      }
      run(database.sqlite, "update desktop_authorizations set consumed_at = ? where id = ?", [new Date().toISOString(), row.id]);
      const token = createSession(database, user.id, request.headers["user-agent"], "link");
      audit(database, user.id, "device.linked", user.id);
      database.sqlite.exec("commit");
      database.save();
      setSessionCookie(reply, token, secureCookies);
      return reply.send({ status: "approved", user: publicUser({ ...user, bannedAt: user.banned_at }) });
    } catch (cause) {
      database.sqlite.exec("rollback");
      throw cause;
    }
  });

  fastify.post("/api/devices/desktop-authorizations/:id/cancel", { config: collectLimit }, async (request, reply) => {
    const params = idSchema.safeParse(request.params);
    const body = secretSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(404).send({ error: "authorization_invalid" });
    const row = one<AuthorizationRow>(database.sqlite,
      `select ${columns} from desktop_authorizations where id = ? and secret_hash = ?`,
      [params.data.id, hashToken(body.data.secret)]
    );
    if (!row || requestOrigin(request) !== row.origin) return reply.code(404).send({ error: "authorization_invalid" });
    run(database.sqlite, "update desktop_authorizations set cancelled_at = coalesce(cancelled_at, ?) where id = ? and consumed_at is null", [new Date().toISOString(), row.id]);
    database.save();
    return reply.send({ ok: true });
  });
}
