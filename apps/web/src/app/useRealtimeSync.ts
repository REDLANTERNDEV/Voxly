import type { AfkTimeoutMinutes,ChatMessage,PresenceStatus,PresenceUser,PublicUser,VoiceForceLeaveReason } from "@voxly/shared";
import { useEffect,useRef,useState,type RefObject } from "react";
import { createVoxlySocket,type VoxlySocket } from "../socket.js";
import type { Route } from "./types.js";

interface RealtimeHandlers {
  presenceSnapshot(serverId: string, users: PresenceUser[]): void;
  presenceOnline(serverId: string, user: PresenceUser): void;
  presenceOffline(serverId: string, userId: string): void;
  presenceStatus(serverId: string, userId: string, status: PresenceStatus): void;
  directoryChanged(serverId: string): void;
  memberUpdated(serverId: string, user: PresenceUser): void;
  serverUpdated(serverId: string, name: string): void;
  afkUpdated(serverId: string, afkTimeoutMinutes: AfkTimeoutMinutes): void;
  roomsChanged(serverId: string, deletedRoomId: string | undefined): void;
  serverDeleted(serverId: string): void;
  messageNew(message: ChatMessage): void;
  messageUpdated(message: ChatMessage): void;
  messageDeleted(roomId: string, messageId: string): void;
  accessRevoked(serverId: string): void;
}

export function useRealtimeSync({ user, route, handlers, activeVoiceRoomRef, leaveVoiceRef, moveVoiceRef, forceLeaveNoticeRef, checkStillSignedInRef }: {
  user: PublicUser | null;
  route: Route;
  handlers: RealtimeHandlers;
  activeVoiceRoomRef: RefObject<string | null>;
  leaveVoiceRef: RefObject<() => void>;
  /** Carries out an owner's move through the ordinary join path. */
  moveVoiceRef: RefObject<(roomId: string) => void>;
  /** Says why voice ended when the member did not end it themselves. */
  forceLeaveNoticeRef: RefObject<(reason: VoiceForceLeaveReason) => void>;
  /** Re-asks the server who this Device is, after a connection is lost. */
  checkStillSignedInRef: RefObject<() => Promise<void>>;
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
    next.on("disconnect", () => {
      setSocketState("offline");
      // A dropped socket is usually the network. But it is also exactly what a
      // member signing this Device out from another one looks like, and sitting
      // on a room the account no longer has any claim to — until somebody
      // happens to refresh — is the worst version of that. Asking who we are
      // settles it either way, and costs one request.
      void checkStillSignedInRef.current();
    });
    next.on("presence:serverSnapshot", ({ serverId, users }) => handlersRef.current.presenceSnapshot(serverId, users));
    next.on("presence:serverOnline", ({ serverId, user: nextUser }) => handlersRef.current.presenceOnline(serverId, nextUser));
    next.on("presence:serverOffline", ({ serverId, userId }) => handlersRef.current.presenceOffline(serverId, userId));
    next.on("presence:serverStatus", ({ serverId, userId, status }) => handlersRef.current.presenceStatus(serverId, userId, status));
    next.on("server:directoryChanged", ({ serverId }) => handlersRef.current.directoryChanged(serverId));
    next.on("server:memberUpdated", ({ serverId, user: nextUser }) => handlersRef.current.memberUpdated(serverId, nextUser));
    next.on("server:updated", ({ serverId, name }) => handlersRef.current.serverUpdated(serverId, name));
    next.on("server:afkUpdated", ({ serverId, afkTimeoutMinutes }) => handlersRef.current.afkUpdated(serverId, afkTimeoutMinutes));
    next.on("server:roomsChanged", ({ serverId, deletedRoomId }) => handlersRef.current.roomsChanged(serverId, deletedRoomId));
    next.on("server:deleted", ({ serverId }) => handlersRef.current.serverDeleted(serverId));
    next.on("message:new", (message) => handlersRef.current.messageNew(message));
    next.on("message:updated", (message) => handlersRef.current.messageUpdated(message));
    next.on("message:deleted", ({ roomId, messageId }) => handlersRef.current.messageDeleted(roomId, messageId));
    next.on("voice:forceLeave", ({ roomId, reason }) => {
      if (activeVoiceRoomRef.current !== roomId) return;
      leaveVoiceRef.current();
      // The member has to be told, or a call that moved is indistinguishable
      // from a call that dropped — and "did it break?" is exactly the question
      // a silent teardown leaves them with.
      forceLeaveNoticeRef.current(reason);
    });
    next.on("voice:moveTo", ({ roomId }) => moveVoiceRef.current(roomId));
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
