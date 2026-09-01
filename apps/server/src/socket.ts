/**
 * Plumbing every Socket.IO handler shares, regardless of which subsystem owns
 * the event.
 *
 * Socket payloads are attacker-controlled and arrive without Fastify's schema
 * layer. A handler that dereferences an unvalidated payload — or calls an ack
 * the client simply omitted — throws inside a Socket.IO listener, which
 * Socket.IO does not catch. That terminates the process and drops every active
 * call, so each event validates its payload up front, treats the ack as
 * optional, and is wrapped so one unhandled throw cannot end every session.
 */

import type { Server, Socket } from "socket.io";
import { z } from "zod";
import type { ClientToServerEvents, PresenceUser, ServerToClientEvents } from "@voxly/shared";

export type VoxlyIoServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type VoxlySocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export const roomIdPayloadSchema = z.string().min(1);

/**
 * Last-resort guard so one unhandled throw cannot end every user's session.
 *
 * Individual handlers still validate their own input; this exists so a future
 * handler that forgets cannot repeat the same outage.
 */
export function safeSocketHandler<Args extends unknown[]>(event: string, handler: (...args: Args) => void) {
  return (...args: Args) => {
    try {
      handler(...args);
    } catch (cause) {
      console.error(`socket handler failed for ${event}`, cause);
    }
  };
}

export function callAck(ack: unknown, response: unknown) {
  if (typeof ack === "function") (ack as (value: unknown) => void)(response);
}

/**
 * A user account can hold several connections at once — extra tabs, a reconnect
 * that has not yet dropped the old socket — and server-side actions such as a
 * ban or a force-leave have to reach all of them.
 */
export function socketsForUser(io: VoxlyIoServer, userId: string) {
  return [...io.sockets.sockets.values()].filter((socket) => {
    const socketUser = socket.data.user as PresenceUser | undefined;
    return socketUser?.userId === userId;
  });
}

/**
 * The sockets of one Device rather than one account.
 *
 * A member holding several Devices is now ordinary, so anything addressed at a
 * Device — signing one out, handing a call to another — has to be able to say
 * which. The session id is stamped on the socket at handshake because that is
 * the only moment the cookie is read.
 */
export function socketsForSession(io: VoxlyIoServer, userId: string, sessionId: string) {
  return socketsForUser(io, userId).filter((socket) => socket.data.sessionId === sessionId);
}
