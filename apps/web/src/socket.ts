import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@voxly/shared";

export type VoxlySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createVoxlySocket(): VoxlySocket {
  return io({
    transports: ["websocket"],
    withCredentials: true,
    reconnectionAttempts: Infinity
  });
}
