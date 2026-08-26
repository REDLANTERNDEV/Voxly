/**
 * Plumbing every route module shares, regardless of which domain owns the
 * route — the HTTP counterpart of `socket.ts`.
 *
 * What a route module is handed, the vocabulary it uses to reach live state,
 * and the rate-limit tiers the groups pick from.
 *
 * HTTP route groups live with the rules they enforce — servers and rooms in
 * `servers.ts`, and so on — rather than in the composition root, the same way
 * `voice.ts` owns its own socket handlers. That only works if the thing a route
 * group needs from the composition root is a type it can import *from here*
 * instead of from `app.ts`, which imports the route modules and would close a
 * cycle. See `docs/adr/0013-route-modules-register-their-own-routes.md`.
 *
 * Nothing in this file decides anything. It is the shape of the handshake:
 * `app.ts` fills a `RouteContext` in and each module registers against it.
 */

import type { FastifyInstance } from "fastify";
import type { PresenceUser, VoiceModerationState } from "@voxly/shared";
import type { VoxlyDatabase } from "./db/database.js";
import type { VoxlyIoServer } from "./socket.js";

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
