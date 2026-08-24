/**
 * The adapter between a live Socket.IO connection and the narrow surface a Set
 * needs.
 *
 * A Set is given this shape rather than a `Socket` so its tests can drive it
 * without a server, and so the events it is allowed to use are visible in one
 * place: join, leave, media state, and RTC signalling. Anything the bot does
 * beyond those is not a Set's business.
 *
 * Publishing the Queue is one such thing, so it is a second adapter rather than
 * a fifth method on the first. It belongs to the responder, which owns the
 * Queue; a Set knows what is sounding and nothing about what is coming next.
 */

import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, MusicQueueState, ServerToClientEvents } from "@voxly/shared";
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

/**
 * The one thing the bot says that reaches more than one person.
 *
 * Fire-and-forget would be the easy shape and the wrong one: the server refuses
 * a publish from a member who is no longer in the room, and a bot that never
 * heard the refusal would go on believing in a Queue nobody can see. The
 * acknowledgement is logged rather than acted on — there is nothing useful to
 * do about it beyond saying so, because the room's own snapshot has already
 * told everyone the bot is gone.
 */
export function publishQueueVia(socket: BotSocket, log: (message: string) => void) {
  return (payload: { roomId: string; state: MusicQueueState }) => {
    socket.emit("music:publish", payload, (response) => {
      if (!response.ok) log(`the server refused the Queue for room ${payload.roomId}: ${response.error}`);
    });
  };
}
