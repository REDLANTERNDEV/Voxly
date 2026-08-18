import type { AfkTimeoutMinutes,PresenceStatus,PresenceUser,PublicUser,RoomSummary,VoiceModerationState } from "@voxly/shared";
import { useCallback,useEffect,useMemo,useRef,useState,type RefObject } from "react";
import { createServer,createServerRoom,deleteServer,deleteServerRoom,disconnectVoiceMember,fetchServerDirectory,fetchServerRooms,fetchServers,moderateServerMember,updateServer,updateServerAfkTimeout,updateServerMemberNickname,updateServerMemberPermissions,updateVoiceModeration } from "../api.js";
import { resolveRememberedRoom,roomsForServer,type RoomHistory } from "../lib/channelState.js";
import { currentServerPresence } from "../lib/memberDirectory.js";
import { replacePresenceUser,replaceServerPresenceUserIfPresent } from "../lib/memberIdentity.js";
import { indexAfkRoom } from "../lib/idleActivity.js";
import { defaultServerId,firstServerRoomPath } from "../lib/navigation.js";
import type { ServerSummary } from "../types.js";
import { serverPath } from "./navigation.js";
import { includeCurrentPresence,presenceFromUser,upsertPresence } from "./presentation.js";
import type { Route } from "./types.js";

export function useWorkspaceController({ user, route, navigate, roomHistory, roomServerIdsRef, routeRef }: {
  user: PublicUser | null;
  route: Route;
  navigate(path: string): void;
  roomHistory: RoomHistory;
  roomServerIdsRef: RefObject<Record<string, string>>;
  routeRef: RefObject<Route>;
}) {
  const [servers, setServers] = useState<ServerSummary[]>([]);

  const [serverListReady, setServerListReady] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [onlineUsersByServer, setOnlineUsersByServer] = useState<Record<string, PresenceUser[]>>({});
  const [serverMembersByServer, setServerMembersByServer] = useState<Record<string, PresenceUser[]>>({});
  // Accumulates across servers, unlike `rooms`, which only ever holds the active
  // one. Voice outlives navigation, so anything keyed off the room a member is
  // connected to has to survive them browsing elsewhere.
  const afkRoomIdsByServerRef = useRef<Record<string, string>>({});
  // Rebuilt from the server list, which every member receives, so the idle
  // clock uses the owner's setting rather than a client-side default.
  const afkTimeoutsByServerRef = useRef<Record<string, AfkTimeoutMinutes>>({});

  const indexRooms = useCallback((nextRooms: RoomSummary[]) => {
    for (const room of nextRooms) roomServerIdsRef.current[room.id] = room.serverId;
    for (const serverId of new Set(nextRooms.map((room) => room.serverId))) {
      indexAfkRoom(afkRoomIdsByServerRef.current, serverId, nextRooms);
    }
  }, []);
  const activeServerId = route.name === "text" || route.name === "voice" || route.name === "owner"
    ? route.serverId : servers[0]?.id ?? defaultServerId;
  const serverMembers = serverMembersByServer[activeServerId] ?? [];
  const onlineUsers = onlineUsersByServer[activeServerId] ?? (user ? [currentServerPresence(user, serverMembers)] : []);
  const activeRooms = useMemo(() => roomsForServer(rooms, activeServerId), [activeServerId, rooms]);
  const currentRoom = activeRooms.find((room) => (route.name === "text" || route.name === "voice") && room.id === route.roomId && room.serverId === route.serverId);
  const roomGroups = useMemo(() => ({
    text: activeRooms.filter((room) => room.kind === "text"),
    voice: activeRooms.filter((room) => room.kind === "voice")
  }), [activeRooms]);
  const voiceRoomIds = useMemo(() => roomGroups.voice.map((room) => room.id), [roomGroups.voice]);

  const refreshServerDirectory = useCallback((serverId: string) => fetchServerDirectory(serverId).then((response) => {
    setServerMembersByServer((current) => ({ ...current, [serverId]: response.members }));
  }), []);

  const refreshRooms = useCallback(async (serverId: string, deletedRoomId?: string) => {
    const response = await fetchServerRooms(serverId);
    const currentRoute = routeRef.current;
    if ((currentRoute.name !== "text" && currentRoute.name !== "voice" && currentRoute.name !== "owner") || currentRoute.serverId !== serverId) return;
    indexRooms(response.rooms);
    setRooms(response.rooms);
    if ((currentRoute.name === "text" || currentRoute.name === "voice") && currentRoute.roomId === deletedRoomId) {
      const target = response.rooms.find((room) => room.kind === currentRoute.name) ?? response.rooms[0];
      if (target) navigate(serverPath(serverId, target.kind, target.id));
    }
  }, [indexRooms, navigate]);

  const refreshServersAfterDeletion = useCallback(async (deletedServerId: string) => {
    const response = await fetchServers();
    setServers(response.servers);
    const currentRoute = routeRef.current;
    if ((currentRoute.name !== "text" && currentRoute.name !== "voice" && currentRoute.name !== "owner") || currentRoute.serverId !== deletedServerId) return;
    const targetServer = response.servers[0];
    if (!targetServer) {
      setRooms([]);
      navigate("/invite");
      return;
    }
    const roomResponse = await fetchServerRooms(targetServer.id);
    indexRooms(roomResponse.rooms);
    setRooms(roomResponse.rooms);
    navigate(firstServerRoomPath(targetServer.id, roomResponse.rooms));
  }, [indexRooms, navigate]);

  const loadAcceptedServer = useCallback(async (serverId: string) => {
    const [serverResponse, roomResponse] = await Promise.all([fetchServers(), fetchServerRooms(serverId)]);
    setServers(serverResponse.servers);
    indexRooms(roomResponse.rooms);
    setRooms(roomResponse.rooms);
    navigate(firstServerRoomPath(serverId, roomResponse.rooms));
  }, [indexRooms, navigate]);

  // One index rebuilt from the whole list, rather than patched at each write
  // site, so a server that disappears cannot leave a stale timeout behind.
  useEffect(() => {
    const next: Record<string, AfkTimeoutMinutes> = {};
    for (const server of servers) next[server.id] = server.afkTimeoutMinutes;
    afkTimeoutsByServerRef.current = next;
  }, [servers]);

  useEffect(() => {
    if (!user) {
      setServerListReady(false);
      setOnlineUsersByServer({});
      setServerMembersByServer({});
      return;
    }
    let mounted = true;
    setServerListReady(false);
    fetchServers().then((response) => {
      if (!mounted) return;
      setServers(response.servers);
      setServerListReady(true);
      if (route.name === "landing" && response.servers[0]) {
        void fetchServerRooms(response.servers[0].id).then((result) => {
          const target = result.rooms.find((room) => room.kind === "text") ?? result.rooms[0];
          if (target && mounted) navigate(serverPath(response.servers[0].id, target.kind, target.id));
        });
      }
    }).catch(() => { if (mounted) { setServers([]); setServerListReady(true); } });
    return () => { mounted = false; };
  }, [navigate, route.name, user]);

  useEffect(() => {
    if (!user || !activeServerId) return;
    let mounted = true;
    fetchServerRooms(activeServerId).then((response) => {
      if (mounted) { indexRooms(response.rooms); setRooms(response.rooms); }
    }).catch(() => { if (mounted) setRooms([]); });
    fetchServerDirectory(activeServerId).then((response) => {
      if (mounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: response.members }));
    }).catch(() => { if (mounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: [] })); });
    return () => { mounted = false; };
  }, [activeServerId, indexRooms, user]);

  useEffect(() => {
    if (route.name !== "owner") return;
    const membership = servers.find((server) => server.id === route.serverId);
    if (membership?.role === "owner" || !serverListReady) return;
    let cancelled = false;
    const fallbackId = membership?.id ?? servers[0]?.id;
    if (!fallbackId) { navigate("/invite"); return; }
    void fetchServerRooms(fallbackId).then((response) => {
      if (cancelled) return;
      const target = response.rooms.find((room) => room.kind === "text") ?? response.rooms[0];
      navigate(target ? serverPath(fallbackId, target.kind, target.id) : "/invite");
    }).catch(() => { if (!cancelled) navigate("/invite"); });
    return () => { cancelled = true; };
  }, [navigate, route, serverListReady, servers]);

  // A member update can flip the viewer's own invite grant, so the server list —
  // which gates every invite affordance in the shell — has to follow it live.
  const applyMemberUpdate = useCallback((serverId: string, next: PresenceUser) => {
    setOnlineUsersByServer((current) => replaceServerPresenceUserIfPresent(current, serverId, next));
    setServerMembersByServer((current) => ({ ...current, [serverId]: replacePresenceUser(current[serverId] ?? [], next) }));
    if (!user || next.userId !== user.id || next.canInvite === undefined) return;
    setServers((current) => current.map((server) => server.id === serverId
      ? { ...server, canInvite: server.role === "owner" || Boolean(next.canInvite) }
      : server));
  }, [user]);

  const actions = {
    selectServer: async (serverId: string) => {
      const response = await fetchServerRooms(serverId);
      const target = resolveRememberedRoom(response.rooms.filter((room) => room.kind === "text"), roomHistory[serverId]?.text) ?? response.rooms[0];
      if (target) navigate(serverPath(serverId, target.kind, target.id));
    },
    createServer: async (name: string) => {
      const response = await createServer(name);
      setServers((current) => [...current, response.server]);
      const result = await fetchServerRooms(response.server.id);
      const target = result.rooms.find((room) => room.kind === "text") ?? result.rooms[0];
      if (target) navigate(serverPath(response.server.id, target.kind, target.id));
    },
    updateServerName: async (name: string) => {
      const response = await updateServer(activeServerId, name);
      setServers((current) => current.map((server) => server.id === activeServerId ? response.server : server));
      return response.server;
    },
    createRoom: async (name: string, kind: "text" | "voice") => {
      const response = await createServerRoom(activeServerId, name, kind);
      indexRooms([response.room]);
      setRooms((current) => [...current, response.room].sort((a, b) => a.position - b.position));
      navigate(serverPath(activeServerId, response.room.kind, response.room.id));
    },
    setAfkTimeout: async (minutes: AfkTimeoutMinutes) => {
      await updateServerAfkTimeout(activeServerId, minutes);
      setServers((current) => current.map((server) => server.id === activeServerId ? { ...server, afkTimeoutMinutes: minutes } : server));
    },
    deleteRoom: async (roomId: string) => { await deleteServerRoom(activeServerId, roomId); await refreshRooms(activeServerId, roomId); },
    deleteServer: async () => { await deleteServer(activeServerId); await refreshServersAfterDeletion(activeServerId); },
    moderateMember: async (userId: string, action: "ban" | "unban" | "kick") => { await moderateServerMember(activeServerId, userId, action); await refreshServerDirectory(activeServerId); },
    voiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) => updateVoiceModeration(activeServerId, userId, moderation),
    updateMemberNickname: async (userId: string, nickname: string) => {
      const response = await updateServerMemberNickname(activeServerId, userId, nickname);
      applyMemberUpdate(activeServerId, response.user);
      return response.user;
    },
    updateMemberPermissions: async (userId: string, canInvite: boolean) => {
      const response = await updateServerMemberPermissions(activeServerId, userId, canInvite);
      applyMemberUpdate(activeServerId, response.user);
      return response.user;
    },
    disconnectMember: (roomId: string, userId: string) => disconnectVoiceMember(activeServerId, roomId, userId)
  };

  return {
    servers, rooms, serverListReady, activeServerId, onlineUsers, serverMembers, activeRooms, currentRoom, roomGroups, voiceRoomIds,
    afkTimeoutsByServerRef,
    afkRoomIdsByServerRef,
    roomServerIdsRef, loadAcceptedServer, refreshServerDirectory, refreshRooms, refreshServersAfterDeletion, actions,
    setServers, setOnlineUsersByServer, setServerMembersByServer,
    applyPresenceSnapshot: (serverId: string, users: PresenceUser[]) => setOnlineUsersByServer((current) => ({ ...current, [serverId]: user ? includeCurrentPresence(users, user) : users })),
    applyPresenceOnline: (serverId: string, next: PresenceUser) => user && setOnlineUsersByServer((current) => ({ ...current, [serverId]: upsertPresence(current[serverId] ?? [presenceFromUser(user)], next, user) })),
    applyPresenceOffline: (serverId: string, userId: string) => setOnlineUsersByServer((current) => ({ ...current, [serverId]: (current[serverId] ?? []).filter((item) => item.userId !== userId) })),
    applyMemberUpdate,
    // Status only ever updates an entry that is already present. Someone who is
    // not in the online list is offline, and an idle report must not resurrect
    // them into it.
    applyPresenceStatus: (serverId: string, userId: string, status: PresenceStatus) => setOnlineUsersByServer((current) => {
      const present = current[serverId];
      if (!present?.some((item) => item.userId === userId)) return current;
      return { ...current, [serverId]: present.map((item) => item.userId === userId ? { ...item, status } : item) };
    }),
    applyServerName: (serverId: string, name: string) => setServers((current) => current.map((server) => server.id === serverId ? { ...server, name } : server)),
    applyAfkTimeout: (serverId: string, afkTimeoutMinutes: AfkTimeoutMinutes) => setServers((current) => current.map((server) => server.id === serverId ? { ...server, afkTimeoutMinutes } : server)),
    revokeAccess: (serverId: string) => {
      setOnlineUsersByServer((current) => { const next = { ...current }; delete next[serverId]; return next; });
      setServerMembersByServer((current) => { const next = { ...current }; delete next[serverId]; return next; });
    }
  };
}
