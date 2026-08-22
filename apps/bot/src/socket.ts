/**
 * The adapter between a live Socket.IO connection and the narrow surface a Set
 * needs.
 *
 * A Set is given this shape rather than a `Socket` so its tests can drive it
 * without a server, and so the events it is allowed to use are visible in one
 * place: join, leave, media state, and RTC signalling. Anything the bot does
 * beyond those is not a Set's business.
 */

import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@voxly/shared";
import type { SetSocket } from "./set.js";

export type BotSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function setSocketFor(socket: BotSocket): SetSocket {
  return {
    join(payload, ack) {
      socket.emit("voice:join", payload, ack);
    },
    leave(roomId) {
      socket.emit("voice:leave", roomId);
    },
    setMediaState(payload, ack) {
      socket.emit("voice:setMediaState", payload, ack);
    },
    onSnapshot(handler) {
      socket.on("voice:snapshot", handler);
    },
    offSnapshot(handler) {
      socket.off("voice:snapshot", handler);
    },
    onForceLeave(handler) {
      socket.on("voice:forceLeave", handler);
    },
    offForceLeave(handler) {
      socket.off("voice:forceLeave", handler);
    },
    emit(payload) {
      socket.emit("rtc:signal", payload);
    },
    on(handler) {
      socket.on("rtc:signal", handler);
    },
    off(handler) {
      socket.off("rtc:signal", handler);
    }
  };
}
