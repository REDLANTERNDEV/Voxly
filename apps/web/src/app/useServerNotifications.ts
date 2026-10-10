import type { NotificationMuteRequest, NotificationStateResponse, PublicUser } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { advanceRoomReadState, fetchNotificationState, updateServerNotificationSettings } from "../api.js";
import { serverNotificationsMuted, unreadRooms } from "../lib/serverNotifications.js";

/** One coalesced refresh pipeline per authenticated Account; old replies never win. */
export function useServerNotifications(user: PublicUser | null, serverIds: string) {
  const [snapshot, setSnapshot] = useState<NotificationStateResponse | null>(null);
  const [error, setError] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const refreshRef = useRef<() => void>(() => undefined);
  const stateRef = useRef<{ userId: string; snapshot: NotificationStateResponse; offset: number } | null>(null);
  const userId = user?.id;
  const seenMessagesRef = useRef(new Map<string, number>());
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    setSnapshot(null);
    stateRef.current = null;
    seenMessagesRef.current.clear();
    setError(false);
    if (!userId) {
      refreshRef.current = () => undefined;
      return;
    }
    let disposed = false,
      busy = false,
      dirty = false,
      version = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      version++;
      dirty = true;
      void drain();
    };
    const drain = async () => {
      if (busy || disposed) return;
      busy = true;
      try {
        while (dirty && !disposed) {
          dirty = false;
          const requested = version;
          try {
            const next = await fetchNotificationState();
            if (disposed || requested !== version) continue;
            stateRef.current = { userId, snapshot: next, offset: Date.parse(next.serverTime) - Date.now() };
            setSnapshot(next);
            setClock(Date.now());
            setError(false);
          } catch {
            if (disposed) return;
            setError(true);
            clearTimeout(retry);
            retry = setTimeout(invalidate, 5_000);
          }
        }
      } finally {
        busy = false;
      }
    };
    refreshRef.current = invalidate;
    const resume = () => {
      setClock(Date.now());
      invalidate();
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    invalidate();
    return () => {
      disposed = true;
      clearTimeout(retry);
      refreshRef.current = () => undefined;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [userId]);
  useEffect(() => {
    if (!snapshot) return;
    const offset = stateRef.current?.offset ?? 0;
    const nextExpiry = Math.min(
      ...snapshot.servers
        .flatMap((server) => (server.mute.mode === "until" ? [Date.parse(server.mute.until) - offset] : []))
        .filter((time) => time > clock)
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => {
        setClock(Date.now());
        refresh();
      },
      Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now()))
    );
    return () => clearTimeout(timer);
  }, [snapshot, clock, refresh]);
  useEffect(refresh, [refresh, serverIds]);
  const markRead = useCallback(
    async (roomId: string, sequence: number) => {
      await advanceRoomReadState(roomId, sequence);
      refresh();
    },
    [refresh]
  );
  const setMute = useCallback(
    async (serverId: string, setting: NotificationMuteRequest) => {
      const response = await updateServerNotificationSettings(serverId, setting);
      const current = stateRef.current;
      const confirmed = response.servers.find((server) => server.serverId === serverId);
      if (current && userId && current.userId === userId && confirmed) {
        const next = {
          ...current.snapshot,
          servers: current.snapshot.servers.map((server) =>
            server.serverId === serverId ? { ...server, mute: confirmed.mute } : server
          )
        };
        stateRef.current = { userId, snapshot: next, offset: Date.parse(response.serverTime) - Date.now() };
        setSnapshot(next);
        setClock(Date.now());
      }
      refresh();
    },
    [refresh, userId]
  );
  const messageAllowed = useCallback(
    (message: import("@voxly/shared").ChatMessage) => {
      if (message.sequence <= (seenMessagesRef.current.get(message.roomId) ?? 0)) return false;
      seenMessagesRef.current.set(message.roomId, message.sequence);
      const current = stateRef.current;
      if (!current || current.userId !== userId) return false;
      const server = current.snapshot.servers.find((server) => server.serverId === message.serverId);
      return Boolean(server) && !serverNotificationsMuted(server, Date.now() + current.offset);
    },
    [userId]
  );
  return {
    snapshot,
    error,
    refresh,
    markRead,
    setMute,
    messageAllowed,
    presentation: {
      unreadByRoom: unreadRooms(snapshot),
      serverNotificationState: snapshot,
      serverNotificationTime: clock + (stateRef.current?.offset ?? 0),
      serverNotificationError: error,
      onServerNotificationSettingsChange: setMute
    }
  };
}
