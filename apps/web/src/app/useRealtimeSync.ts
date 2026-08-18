import type { ChatMessage,PresenceUser,PublicUser } from "@voxly/shared";
import { useEffect,useRef,useState,type RefObject } from "react";
import { createVoxlySocket,type VoxlySocket } from "../socket.js";
import type { Route } from "./types.js";

interface RealtimeHandlers {
  presenceSnapshot(serverId: string, users: PresenceUser[]): void;
  presenceOnline(serverId: string, user: PresenceUser): void;
  presenceOffline(serverId: string, userId: string): void;
  directoryChanged(serverId: string): void;
  memberUpdated(serverId: string, user: PresenceUser): void;
  serverUpdated(serverId: string, name: string): void;
  roomsChanged(serverId: string, deletedRoomId: string | undefined): void;
  serverDeleted(serverId: string): void;
  messageNew(message: ChatMessage): void;
  messageUpdated(message: ChatMessage): void;
  messageDeleted(roomId: string, messageId: string): void;
  accessRevoked(serverId: string): void;
}

export function useRealtimeSync({ user, route, handlers, activeVoiceRoomRef, leaveVoiceRef }: {
  user: PublicUser | null;
  route: Route;
  handlers: RealtimeHandlers;
  activeVoiceRoomRef: RefObject<string | null>;
  leaveVoiceRef: RefObject<() => void>;
}) {
  const [socket, setSocket] = useState<VoxlySocket | null>(null);
  const [socketState, setSocketState] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!user) { setSocket(null); return; }
    const next = createVoxlySocket();
    setSocket(next);
    setSocketState("connecting");
    next.on("connect", () => setSocketState("live"));
    next.io.on("reconnect_attempt", () => setSocketState("reconnecting"));
    next.on("disconnect", () => setSocketState("offline"));
    next.on("presence:serverSnapshot", ({ serverId, users }) => handlersRef.current.presenceSnapshot(serverId, users));
    next.on("presence:serverOnline", ({ serverId, user: nextUser }) => handlersRef.current.presenceOnline(serverId, nextUser));
    next.on("presence:serverOffline", ({ serverId, userId }) => handlersRef.current.presenceOffline(serverId, userId));
    next.on("server:directoryChanged", ({ serverId }) => handlersRef.current.directoryChanged(serverId));
    next.on("server:memberUpdated", ({ serverId, user: nextUser }) => handlersRef.current.memberUpdated(serverId, nextUser));
    next.on("server:updated", ({ serverId, name }) => handlersRef.current.serverUpdated(serverId, name));
    next.on("server:roomsChanged", ({ serverId, deletedRoomId }) => handlersRef.current.roomsChanged(serverId, deletedRoomId));
    next.on("server:deleted", ({ serverId }) => handlersRef.current.serverDeleted(serverId));
    next.on("message:new", (message) => handlersRef.current.messageNew(message));
    next.on("message:updated", (message) => handlersRef.current.messageUpdated(message));
    next.on("message:deleted", ({ roomId, messageId }) => handlersRef.current.messageDeleted(roomId, messageId));
    next.on("voice:forceLeave", ({ roomId }) => { if (activeVoiceRoomRef.current === roomId) leaveVoiceRef.current(); });
    next.on("server:accessRevoked", ({ serverId }) => handlersRef.current.accessRevoked(serverId));
    return () => { next.disconnect(); setSocket(null); };
  }, [user]);

  useEffect(() => {
    if (!socket || route.name !== "text") return;
    socket.emit("room:join", route.roomId);
    return () => { socket.emit("room:leave", route.roomId); };
  }, [route, socket]);

  return { socket, socketState };
}
