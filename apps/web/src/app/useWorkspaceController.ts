import type {
  AfkTimeoutMinutes,
  ServerWelcomeSettings,
  CategorySummary,
  PresenceStatus,
  PresenceUser,
  PublicUser,
  RoleChange,
  RoleSummary,
  RoomSummary,
  ServerRoomLayout,
  VoiceModerationState,
  RoomAccessUpdate
} from "@voxly/shared";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  createServer,
  createServerCategory,
  createServerRoom,
  deleteServer,
  deleteServerCategory,
  deleteServerRoom,
  disconnectVoiceMember,
  fetchServerDirectory,
  fetchServerRoles,
  setServerMemberRole,
  createServerRole,
  updateServerRole,
  reorderServerRoles,
  deleteServerRole,
  fetchServerRooms,
  fetchServers,
  moderateServerMember,
  moveVoiceMember,
  renameServerCategory,
  renameServerRoom,
  updateServerRoomAccess,
  updateServer,
  updateServerAfkTimeout,
  updateServerWelcome,
  updateServerMemberNickname,
  updateServerRoomLayout,
  updateVoiceModeration
} from "../api.js";
import { resolveRememberedRoom, roomsForServer, type RoomHistory } from "../lib/channelState.js";
import { currentServerPresence } from "../lib/memberDirectory.js";
import { replacePresenceUser, replaceServerPresenceUserIfPresent } from "../lib/memberIdentity.js";
import { indexAfkRoom } from "../lib/idleActivity.js";
import { defaultServerId, firstServerRoomPath } from "../lib/navigation.js";
import type { ServerSummary } from "../types.js";
import { serverPath } from "./navigation.js";
import { includeCurrentPresence, presenceFromUser, upsertPresence } from "./presentation.js";
import type { Route } from "./types.js";
import { desktopNotificationPath, type DesktopNotificationTarget } from "../lib/desktopNotifications.js";

const noRoles: RoleSummary[] = [];

export function useWorkspaceController({
  user,
  route,
  navigate,
  roomHistory,
  roomServerIdsRef,
  routeRef
}: {
  user: PublicUser | null;
  route: Route;
  navigate(path: string): void;
  roomHistory: RoomHistory;
  roomServerIdsRef: RefObject<Record<string, string>>;
  routeRef: RefObject<Route>;
}) {
  const accountId = user?.id;
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [rolesByServer, setRolesByServer] = useState<Record<string, RoleSummary[]>>({});

  const [serverListReady, setServerListReady] = useState(false);
  const [serverListError, setServerListError] = useState(false);
  const [roomsLoad, setRoomsLoad] = useState<{ serverId: string; state: "loading" | "ready" | "error" }>({
    serverId: "",
    state: "loading"
  });
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [uncategorizedPosition, setUncategorizedPosition] = useState(0);
  const [onlineUsersByServer, setOnlineUsersByServer] = useState<Record<string, PresenceUser[]>>({});
  const [serverMembersByServer, setServerMembersByServer] = useState<Record<string, PresenceUser[]>>({});
  // Accumulates across servers, unlike `rooms`, which only ever holds the active
  // one. Voice outlives navigation, so anything keyed off the room a member is
  // connected to has to survive them browsing elsewhere.
  const afkRoomIdsByServerRef = useRef<Record<string, string>>({});
  // Rebuilt from the server list, which every member receives, so the idle
  // clock uses the owner's setting rather than a client-side default.
  const afkTimeoutsByServerRef = useRef<Record<string, AfkTimeoutMinutes>>({});
  // Reactive, unlike the ref above, because the media layer has to react to it:
  // knowing a room is AFK is what keeps the local microphone track disabled, and
  // that cannot wait for a render that a ref would not trigger.
  const [afkRoomIds, setAfkRoomIds] = useState<string[]>([]);

  const indexRooms = useCallback(
    (nextRooms: RoomSummary[]) => {
      for (const room of nextRooms) roomServerIdsRef.current[room.id] = room.serverId;
      for (const serverId of new Set(nextRooms.map((room) => room.serverId))) {
        indexAfkRoom(afkRoomIdsByServerRef.current, serverId, nextRooms);
      }
      setAfkRoomIds((current) => {
        const next = Object.values(afkRoomIdsByServerRef.current).sort();
        return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
      });
    },
    [roomServerIdsRef]
  );
  const activeServerId =
    route.name === "text" || route.name === "voice" || route.name === "owner"
      ? route.serverId
      : (servers[0]?.id ?? defaultServerId);
  const serverMembers = serverMembersByServer[activeServerId] ?? [];
  const serverRoles = rolesByServer[activeServerId] ?? noRoles;
  const onlineUsers = onlineUsersByServer[activeServerId] ?? (user ? [currentServerPresence(user, serverMembers)] : []);
  const activeRooms = useMemo(() => roomsForServer(rooms, activeServerId), [activeServerId, rooms]);
  const currentRoom = activeRooms.find(
    (room) =>
      (route.name === "text" || route.name === "voice") && room.id === route.roomId && room.serverId === route.serverId
  );
  const roomGroups = useMemo(
    () => ({
      text: activeRooms.filter((room) => room.kind === "text"),
      voice: activeRooms.filter((room) => room.kind === "voice")
    }),
    [activeRooms]
  );
  const voiceRoomIds = useMemo(() => roomGroups.voice.map((room) => room.id), [roomGroups.voice]);

  const refreshServerDirectory = useCallback(
    (serverId: string) =>
      fetchServerDirectory(serverId).then((response) => {
        setServerMembersByServer((current) => ({ ...current, [serverId]: response.members }));
      }),
    []
  );

  /**
   * A Server's Roles and what they now make this member. Asked again on every
   * `server:rolesChanged`, because any change to anyone's Roles can change the
   * viewer's own Permissions, and only the server works those out (ADR-0038).
   */
  const refreshServerRoles = useCallback(
    (serverId: string) =>
      fetchServerRoles(serverId).then((response) => {
        setRolesByServer((current) => ({ ...current, [serverId]: response.roles }));
        setServers((current) =>
          current.map((server) =>
            server.id === serverId ? { ...server, permissions: response.permissions, rank: response.rank } : server
          )
        );
      }),
    []
  );

  const refreshRooms = useCallback(
    async (serverId: string, deletedRoomId?: string) => {
      const response = await fetchServerRooms(serverId);
      const currentRoute = routeRef.current;
      if (
        (currentRoute.name !== "text" && currentRoute.name !== "voice" && currentRoute.name !== "owner") ||
        currentRoute.serverId !== serverId
      )
        return;
      indexRooms(response.rooms);
      setRooms(response.rooms);
      setCategories(response.categories);
      setUncategorizedPosition(response.uncategorizedPosition);
      // A deleted channel and a Hidden channel the member just lost access to
      // look the same from here: the viewed channel is no longer in their list.
      if (
        (currentRoute.name === "text" || currentRoute.name === "voice") &&
        (currentRoute.roomId === deletedRoomId || !response.rooms.some((room) => room.id === currentRoute.roomId))
      ) {
        const target = response.rooms.find((room) => room.kind === currentRoute.name) ?? response.rooms[0];
        if (target) navigate(serverPath(serverId, target.kind, target.id));
      }
    },
    [indexRooms, navigate, routeRef]
  );

  const refreshServersAfterDeletion = useCallback(
    async (deletedServerId: string) => {
      const response = await fetchServers();
      setServers(response.servers);
      const currentRoute = routeRef.current;
      if (
        (currentRoute.name !== "text" && currentRoute.name !== "voice" && currentRoute.name !== "owner") ||
        currentRoute.serverId !== deletedServerId
      )
        return;
      const targetServer = response.servers[0];
      if (!targetServer) {
        setRooms([]);
        setCategories([]);
        setUncategorizedPosition(0);
        navigate("/invite");
        return;
      }
      const roomResponse = await fetchServerRooms(targetServer.id);
      indexRooms(roomResponse.rooms);
      setRooms(roomResponse.rooms);
      setCategories(roomResponse.categories);
      setUncategorizedPosition(roomResponse.uncategorizedPosition);
      navigate(firstServerRoomPath(targetServer.id, roomResponse.rooms));
    },
    [indexRooms, navigate, routeRef]
  );

  const loadAcceptedServer = useCallback(
    async (serverId: string) => {
      const [serverResponse, roomResponse] = await Promise.all([fetchServers(), fetchServerRooms(serverId)]);
      setServers(serverResponse.servers);
      indexRooms(roomResponse.rooms);
      setRooms(roomResponse.rooms);
      setCategories(roomResponse.categories);
      setUncategorizedPosition(roomResponse.uncategorizedPosition);
      navigate(firstServerRoomPath(serverId, roomResponse.rooms));
    },
    [indexRooms, navigate]
  );

  // One index rebuilt from the whole list, rather than patched at each write
  // site, so a server that disappears cannot leave a stale timeout behind.
  useEffect(() => {
    const next: Record<string, AfkTimeoutMinutes> = {};
    for (const server of servers) next[server.id] = server.afkTimeoutMinutes;
    afkTimeoutsByServerRef.current = next;
  }, [servers]);

  useEffect(() => {
    if (!accountId) {
      setServerListReady(false);
      setOnlineUsersByServer({});
      setServerMembersByServer({});
      setRolesByServer({});
      return;
    }
    let mounted = true;
    setServerListReady(false);
    setServerListError(false);
    fetchServers()
      .then((response) => {
        if (!mounted) return;
        setServers(response.servers);
        setServerListReady(true);
        if (response.servers.length === 0) navigate("/invite");
      })
      .catch(() => {
        if (mounted) {
          setServers([]);
          setServerListReady(true);
          setServerListError(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, [navigate, accountId]);

  const hasActiveMembership = servers.some((server) => server.id === activeServerId);
  useEffect(() => {
    if (!accountId || !serverListReady || serverListError || !hasActiveMembership) return;
    let mounted = true;
    setRoomsLoad({ serverId: activeServerId, state: "loading" });
    fetchServerRooms(activeServerId)
      .then((response) => {
        if (mounted) {
          indexRooms(response.rooms);
          setRooms(response.rooms);
          setCategories(response.categories);
          setUncategorizedPosition(response.uncategorizedPosition);
          setRoomsLoad({ serverId: activeServerId, state: "ready" });
        }
      })
      .catch(() => {
        if (mounted) {
          setRooms([]);
          setCategories([]);
          setUncategorizedPosition(0);
          setRoomsLoad({ serverId: activeServerId, state: "error" });
        }
      });
    fetchServerDirectory(activeServerId)
      .then((response) => {
        if (mounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: response.members }));
      })
      .catch(() => {
        if (mounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: [] }));
      });
    void refreshServerRoles(activeServerId).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [
    activeServerId,
    indexRooms,
    hasActiveMembership,
    serverListReady,
    serverListError,
    accountId,
    refreshServerRoles
  ]);

  useEffect(() => {
    if (
      accountId &&
      route.name === "landing" &&
      serverListReady &&
      roomsLoad.serverId === activeServerId &&
      roomsLoad.state === "ready"
    ) {
      navigate(activeRooms.length ? firstServerRoomPath(activeServerId, activeRooms) : "/invite");
    }
  }, [accountId, route.name, serverListReady, roomsLoad, activeServerId, activeRooms, navigate]);

  useEffect(() => {
    if (route.name !== "owner" && route.name !== "text" && route.name !== "voice") return;
    const membership = servers.find((server) => server.id === route.serverId);
    // The owner panel is the Installation owner's; anyone else is sent on to a channel.
    if (!serverListReady || serverListError || (membership && (route.name !== "owner" || user?.role === "owner")))
      return;
    let cancelled = false;
    const fallbackId = membership?.id ?? servers[0]?.id;
    if (!fallbackId) {
      navigate("/invite");
      return;
    }
    void fetchServerRooms(fallbackId)
      .then((response) => {
        if (cancelled) return;
        const target = response.rooms.find((room) => room.kind === "text") ?? response.rooms[0];
        navigate(target ? serverPath(fallbackId, target.kind, target.id) : "/invite");
      })
      .catch(() => {
        if (!cancelled) navigate("/invite");
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, route, serverListReady, serverListError, servers, user?.role]);

  const applyMemberUpdate = useCallback((serverId: string, next: PresenceUser) => {
    setOnlineUsersByServer((current) => replaceServerPresenceUserIfPresent(current, serverId, next));
    setServerMembersByServer((current) => ({
      ...current,
      [serverId]: replacePresenceUser(current[serverId] ?? [], next)
    }));
  }, []);

  const actions = {
    selectServer: async (serverId: string) => {
      const response = await fetchServerRooms(serverId);
      const target =
        resolveRememberedRoom(
          response.rooms.filter((room) => room.kind === "text"),
          roomHistory[serverId]?.text
        ) ?? response.rooms[0];
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
      // Only the name changed; the rest of the summary (AFK, welcome, Permissions) stays.
      setServers((current) =>
        current.map((server) => (server.id === activeServerId ? { ...server, name: response.server.name } : server))
      );
      return response.server;
    },
    createRoom: async (name: string, kind: "text" | "voice", categoryId: string | null = null) => {
      const response = await createServerRoom(activeServerId, name, kind, categoryId);
      indexRooms([response.room]);
      setRooms((current) =>
        [...current.filter((room) => room.id !== response.room.id), response.room].sort(
          (a, b) => a.position - b.position
        )
      );
      navigate(serverPath(activeServerId, response.room.kind, response.room.id));
    },
    updateRoomAccess: async (roomId: string, access: RoomAccessUpdate) => {
      const serverId = activeServerId;
      await updateServerRoomAccess(serverId, roomId, access);
      // The server re-shapes every member's view of the list; the owner's own
      // copy is simply fetched again rather than patched by hand.
      await refreshRooms(serverId);
    },
    renameRoom: async (roomId: string, name: string) => {
      const serverId = activeServerId;
      const response = await renameServerRoom(serverId, roomId, name);
      setRooms((current) =>
        current.map((room) => (room.id === roomId && room.serverId === serverId ? response.room : room))
      );
    },
    createCategory: async (name: string) => {
      const response = await createServerCategory(activeServerId, name);
      setCategories((current) =>
        [...current.filter((category) => category.id !== response.category.id), response.category].sort(
          (a, b) => a.position - b.position
        )
      );
    },
    renameCategory: async (categoryId: string, name: string) => {
      const response = await renameServerCategory(activeServerId, categoryId, name);
      setCategories((current) =>
        current.map((category) => (category.id === categoryId ? response.category : category))
      );
    },
    deleteCategory: async (categoryId: string) => {
      await deleteServerCategory(activeServerId, categoryId);
      await refreshRooms(activeServerId);
    },
    saveRoomLayout: async (layout: ServerRoomLayout) => {
      const response = await updateServerRoomLayout(activeServerId, layout);
      indexRooms(response.rooms);
      setRooms(response.rooms);
      setCategories(response.categories);
      setUncategorizedPosition(response.uncategorizedPosition);
    },
    setAfkTimeout: async (minutes: AfkTimeoutMinutes) => {
      await updateServerAfkTimeout(activeServerId, minutes);
      setServers((current) =>
        current.map((server) => (server.id === activeServerId ? { ...server, afkTimeoutMinutes: minutes } : server))
      );
    },
    setWelcome: async (settings: ServerWelcomeSettings) => {
      const saved = await updateServerWelcome(activeServerId, settings);
      setServers((current) =>
        current.map((server) => (server.id === activeServerId ? { ...server, ...saved } : server))
      );
    },
    deleteRoom: async (roomId: string) => {
      await deleteServerRoom(activeServerId, roomId);
      await refreshRooms(activeServerId, roomId);
    },
    deleteServer: async () => {
      await deleteServer(activeServerId);
      await refreshServersAfterDeletion(activeServerId);
    },
    moderateMember: async (userId: string, action: "ban" | "unban" | "kick") => {
      await moderateServerMember(activeServerId, userId, action);
      await refreshServerDirectory(activeServerId);
    },
    voiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) =>
      updateVoiceModeration(activeServerId, userId, moderation),
    updateMemberNickname: async (userId: string, nickname: string) => {
      const response = await updateServerMemberNickname(activeServerId, userId, nickname);
      applyMemberUpdate(activeServerId, response.user);
      return response.user;
    },
    // The Profile dialog edits every server at once, so this one names its server
    // rather than following the one being viewed.
    updateOwnNickname: async (serverId: string, nickname: string | null) => {
      if (!accountId) throw new Error("not_signed_in");
      const response = await updateServerMemberNickname(serverId, accountId, nickname);
      applyMemberUpdate(serverId, response.user);
      return response.user;
    },
    // Each answer is applied at once; `server:rolesChanged` then brings the
    // viewer's own Permissions, which only the server works out.
    createRole: async (name: string) => {
      const serverId = activeServerId;
      const response = await createServerRole(serverId, name);
      await refreshServerRoles(serverId);
      return response.role;
    },
    updateRole: async (roleId: string, change: RoleChange) => {
      const serverId = activeServerId;
      const response = await updateServerRole(serverId, roleId, change);
      setRolesByServer((current) => ({
        ...current,
        [serverId]: (current[serverId] ?? []).map((role) => (role.id === roleId ? response.role : role))
      }));
      return response.role;
    },
    reorderRoles: async (roleIds: string[]) => {
      const serverId = activeServerId;
      const response = await reorderServerRoles(serverId, roleIds);
      setRolesByServer((current) => ({ ...current, [serverId]: response.roles }));
    },
    deleteRole: async (roleId: string) => {
      const serverId = activeServerId;
      await deleteServerRole(serverId, roleId);
      // The server renumbered every position; read them back rather than guess.
      await refreshServerRoles(serverId);
    },
    setMemberRole: async (userId: string, roleId: string, give: boolean) => {
      const response = await setServerMemberRole(activeServerId, userId, roleId, give);
      applyMemberUpdate(activeServerId, response.user);
      return response.user;
    },
    disconnectMember: (roomId: string, userId: string) => disconnectVoiceMember(activeServerId, roomId, userId),
    // Fire and forget: the move is carried out by the target's own client, so
    // there is no state here to reconcile — the voice snapshot reports it.
    moveMember: (userId: string, roomId: string) => {
      void moveVoiceMember(activeServerId, userId, roomId).catch(() => undefined);
    }
  };

  return {
    openNotificationTarget: (target: DesktopNotificationTarget) => {
      const path = desktopNotificationPath(target, roomServerIdsRef.current, servers);
      if (user && path) navigate(path);
    },
    workspaceReady: serverListReady && roomsLoad.serverId === activeServerId && roomsLoad.state === "ready",
    workspaceError: serverListError || (roomsLoad.serverId === activeServerId && roomsLoad.state === "error"),
    servers,
    rooms,
    categories: categories.filter((category) => category.serverId === activeServerId),
    uncategorizedPosition,
    serverListReady,
    activeServerId,
    onlineUsers,
    serverMembers,
    serverRoles,
    activeRooms,
    currentRoom,
    roomGroups,
    voiceRoomIds,
    afkRoomIds,
    afkTimeoutsByServerRef,
    afkRoomIdsByServerRef,
    roomServerIdsRef,
    loadAcceptedServer,
    refreshServerDirectory,
    refreshServerRoles,
    refreshRooms,
    refreshServersAfterDeletion,
    actions,
    setServers,
    setOnlineUsersByServer,
    setServerMembersByServer,
    applyPresenceSnapshot: (serverId: string, users: PresenceUser[]) =>
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: user ? includeCurrentPresence(users, user) : users
      })),
    applyPresenceOnline: (serverId: string, next: PresenceUser) =>
      user &&
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: upsertPresence(current[serverId] ?? [presenceFromUser(user)], next, user)
      })),
    applyPresenceOffline: (serverId: string, userId: string) =>
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: (current[serverId] ?? []).filter((item) => item.userId !== userId)
      })),
    applyMemberUpdate,
    // Status only ever updates an entry that is already present. Someone who is
    // not in the online list is offline, and an idle report must not resurrect
    // them into it.
    applyPresenceStatus: (serverId: string, userId: string, status: PresenceStatus) =>
      setOnlineUsersByServer((current) => {
        const present = current[serverId];
        if (!present?.some((item) => item.userId === userId)) return current;
        return { ...current, [serverId]: present.map((item) => (item.userId === userId ? { ...item, status } : item)) };
      }),
    /** The server summary fields an owner changes, as they arrive over realtime, keyed by event handler. */
    serverSummaryUpdates: {
      // A Role change missed while offline must not leave stale Permissions.
      reconnected: () => {
        void refreshServerRoles(activeServerId).catch(() => undefined);
      },
      rolesChanged: (serverId: string) => {
        void refreshServerRoles(serverId).catch(() => undefined);
      },
      serverUpdated: (serverId: string, name: string) =>
        setServers((current) => current.map((server) => (server.id === serverId ? { ...server, name } : server))),
      afkUpdated: (serverId: string, afkTimeoutMinutes: AfkTimeoutMinutes) =>
        setServers((current) =>
          current.map((server) => (server.id === serverId ? { ...server, afkTimeoutMinutes } : server))
        ),
      welcomeUpdated: (serverId: string, settings: ServerWelcomeSettings) =>
        setServers((current) =>
          current.map((server) =>
            server.id === serverId
              ? { ...server, welcomeNotices: settings.welcomeNotices, welcomeRoomId: settings.welcomeRoomId }
              : server
          )
        )
    },
    revokeAccess: (serverId: string) => {
      setOnlineUsersByServer((current) => {
        const next = { ...current };
        delete next[serverId];
        return next;
      });
      setServerMembersByServer((current) => {
        const next = { ...current };
        delete next[serverId];
        return next;
      });
      setRolesByServer((current) => {
        const next = { ...current };
        delete next[serverId];
        return next;
      });
    }
  };
}
