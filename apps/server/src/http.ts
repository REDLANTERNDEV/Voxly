/**
 * Plumbing every route module shares, regardless of which domain owns the
 * route — the HTTP counterpart of `socket.ts`.
 *
 * What a route module is handed, the vocabulary it uses to reach live state,
 * the rate-limit tiers the groups pick from, and the preamble every
 * server-scoped route runs before it does anything else.
 *
 * HTTP route groups live with the rules they enforce — servers and rooms in
 * `servers.ts`, and so on — rather than in the composition root, the same way
 * `voice.ts` owns its own socket handlers. That only works if the thing a route
 * group needs from the composition root is a type it can import *from here*
 * instead of from `app.ts`, which imports the route modules and would close a
 * cycle. See `docs/adr/0013-route-modules-register-their-own-routes.md`.
 *
 * Nothing here decides who may do what — `auth/sessions.ts` answers who the
 * caller is and `members.ts` answers what that makes them in a given server.
 * This file only puts the two in the order every route needs them, so that
 * order is written once rather than fifteen times.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PresenceUser, VoiceModerationState } from "@voxly/shared";
import { requireOwner, requireUser } from "./auth/sessions.js";
import type { VoxlyDatabase } from "./db/database.js";
import { requireServerMember, requireServerOwner } from "./members.js";
import type { VoxlyIoServer } from "./socket.js";
import type { TurnstileConfig } from "./turnstile.js";

/**
 * The moderation and teardown surface routes call. Routes speak this
 * vocabulary; `voice.ts` and the connection registry in `app.ts` own the
 * implementations behind it, so a route never reaches into live voice state
 * itself.
 */
export interface RealtimeModeration {
  disconnectVoice: (serverId: string, roomId: string, userId: string) => boolean;
  moveVoice: (serverId: string, userId: string, targetRoomId: string) => boolean;
  /** Evict every live socket for a user, across all servers. Used by the global ban. */
  disconnectUser: (userId: string) => void;
  /**
   * Evict only the sockets belonging to one session. A member signing out one
   * of their own Devices must not drop the others.
   */
  disconnectDevice: (userId: string, sessionId: string) => void;
  /**
   * Evict every Device *except* the one asking. Used where a member is clearing
   * out their account from a Device they are still sitting at.
   */
  disconnectOtherDevices: (userId: string, keepSessionId: string) => void;
  deleteRoom: (serverId: string, roomId: string) => void;
  deleteServer: (serverId: string, roomIds: string[], affectedUserIds: string[]) => void;
  grantServerAccess: (serverId: string, userId: string) => Promise<void>;
  refreshMemberIdentity: (serverId: string, userId: string) => PresenceUser | null;
  revokeServerAccess: (serverId: string, userId: string, reason: "banned" | "kicked") => void;
  updateVoiceModeration: (serverId: string, userId: string, moderation: VoiceModerationState) => void;
}

/**
 * Everything a route module may reach for, and deliberately nothing else. The
 * composition root sees the full `CreateVoxlyAppOptions`; a route group gets
 * only the settings its handlers actually read, so a new option cannot quietly
 * become something a route depends on.
 */
export interface RouteContext {
  /**
   * The instance to register against. Named for the framework rather than
   * `server`, which in this codebase is a Voxly server that routes address by
   * `serverId`; one word for one thing (`CONTEXT.md`).
   */
  fastify: FastifyInstance;
  database: VoxlyDatabase;
  io: VoxlyIoServer;
  realtime: RealtimeModeration;
  /** Cookie transport policy; the session guards in `auth/sessions.ts` need it. */
  secureCookies: boolean;
  /**
   * The operator's Turnstile challenge, when they configured one. Read by
   * exactly one route — invite acceptance without a session, the only endpoint
   * that mints an account for a stranger (`invites.ts`). Absent means no
   * challenge is asked for anywhere.
   */
  turnstile?: TurnstileConfig;
}

/**
 * Rate limit tiers.
 *
 * Tokens are 256-bit and stored hashed, so these are not a guessing defence —
 * they bound resource abuse: unauthenticated endpoints that hit the database
 * before any session exists, and authenticated writes that a single account
 * could otherwise flood.
 */
export const unauthenticatedWriteLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };
export const authenticatedWriteLimit = { rateLimit: { max: 60, timeWindow: "1 minute" } };
export const messageLimit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

/** A Voxly server id as it appears in a route path. */
export const serverIdParam = z.string().min(1);

/** A room id as it appears in a route path. */
export const roomIdParam = z.string().min(1);

/**
 * A member id as it appears in a route path — always a UUID.
 *
 * Bot accounts are given UUIDs precisely so that a readable id cannot make one
 * unmuteable, and every server-scoped moderation route has to hold that line
 * (`AGENTS.md`, The Music Bot). Stating the rule once is what stops the next
 * route from quietly loosening it.
 */
export const userIdParam = z.string().uuid();

/**
 * The preamble a server-scoped route shares: an authenticated caller, the path
 * parameters, and an active membership of the server the path names.
 *
 * Returning `null` means the caller has already been answered — 401 for no
 * session, 403 for a session with no business in that server — so a route reads
 * `if (!scope) return;` and never re-decides either answer for itself.
 */
function requireServerScope<Shape extends z.ZodRawShape>(
  { database, secureCookies }: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  extra: Shape,
  role: "owner" | "member"
) {
  const actor = role === "owner"
    ? requireOwner(database, request, reply, secureCookies)
    : requireUser(database, request, reply, secureCookies);
  if (!actor) return null;
  // One parse, so a bad `serverId` and a bad `userId` are still answered by the
  // single 400 the error handler turns any ZodError into. The assertion states
  // what the schema literally is; the spread is what TypeScript loses.
  const params = z.object({ serverId: serverIdParam, ...extra }).parse(request.params) as
    { serverId: string } & z.output<z.ZodObject<Shape>>;
  const guard = role === "owner" ? requireServerOwner : requireServerMember;
  if (!guard(database, params.serverId, actor.id, reply)) return null;
  return { actor, params };
}

/**
 * An active owner of the server the path names, plus the path parameters.
 *
 * Routes that must parse the request body *before* the ownership check cannot
 * use this — the order in which a bad body and a forbidden caller are answered
 * is observable — and spell the three steps out instead.
 */
export function requireOwnedServer<Shape extends z.ZodRawShape = Record<string, never>>(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  extra: Shape = {} as Shape
) {
  const scope = requireServerScope(context, request, reply, extra, "owner");
  return scope && { owner: scope.actor, ...scope.params };
}

/** An active, non-banned, non-removed member of the server the path names. */
export function requireJoinedServer<Shape extends z.ZodRawShape = Record<string, never>>(
  context: RouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
  extra: Shape = {} as Shape
) {
  const scope = requireServerScope(context, request, reply, extra, "member");
  return scope && { user: scope.actor, ...scope.params };
}
