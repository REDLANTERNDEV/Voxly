import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import type {
  ChatMessage,
  PresenceUser,
  PublicUser,
  RoomSummary,
  VisualMediaKind,
  VisualTarget,
  VoiceMediaState,
  VoiceModerationState,
  VoiceSnapshot
} from "@voxly/shared";
import {
  acceptInvite,
  ApiError,
  claimOwnerSession,
  claimAccessLink,
  createServer,
  createServerRoom,
  createAccessLink,
  createServerInvite,
  deleteMessage,
  deleteServer,
  deleteServerRoom,
  disconnectVoiceMember,
  fetchConfig,
  fetchMe,
  fetchRtcConfig,
  fetchMessages,
  fetchServerDirectory,
  fetchServerOwnerData,
  fetchServerRooms,
  fetchServers,
  logout,
  revokeServerInvite,
  moderateServerMember,
  previewInvite,
  sendMessage,
  suppressMessageEmbed,
  updateMessage,
  updateServer,
  updateServerMemberNickname,
  updateVoiceModeration
} from "./api.js";
import { createVoxlySocket, type VoxlySocket } from "./socket.js";
import type { AppConfigResponse, InviteExpiryMinutes, InviteMaxUses, OwnerInvite, RtcConfigResponse, ServerMember, ServerSummary } from "./types.js";
import {
  connectAudioOutput,
  releaseUnusedSharedAudioOutput,
  retryBlockedAudioOutputs,
  subscribeBlockedAudioOutputs,
  unlockSharedAudioOutput,
  type AudioOutput
} from "./lib/audioOutput.js";
import { controlPresentation, sidebarVoiceStatusKeys, type VoiceControls } from "./lib/voiceControls.js";
import { connectionStatusFor, type PeerConnectionState } from "./lib/voiceNegotiation.js";
import { defaultServerId, firstServerRoomPath, getAccessClaimTokenFromHash, getInviteTokenFromPath, getOwnerClaimTokenFromHash, parsePathRoute, resolveInitialRoute } from "./lib/navigation.js";
import { buildInviteUrl, inviteReference, maskSecretLink, resolveInviteOrigin } from "./lib/invites.js";
import {
  formatMessageDateTime,
  formatMessageTimestamp,
  isMessageListNearBottom,
  messageListUpdateAction,
  messageDeleteFailureCopy,
  messagePermissions,
  shouldSubmitComposer
} from "./lib/messages.js";
import { messageContentSegments, messageEmbeds, type MessageEmbed } from "./lib/messageEmbeds.js";
import {
  clampContextMenuPosition,
  contextMenuReducer,
  createContextMenuDescriptor,
  type ContextMenuDescriptor
} from "./lib/contextMenu.js";
import { useVoiceMedia, type VoiceJoinOptions } from "./lib/useVoiceMedia.js";
import { useConnectionHealth, type ConnectionHealth } from "./lib/useConnectionHealth.js";
import type { VisualSubscriptionResult } from "./lib/voiceRecovery.js";
import { replaceVisualTarget, toggleVisualTarget, visualTargetKey } from "./lib/voiceResume.js";
import { participantsForViewedRoom, remoteStreamKey, type RemoteStreamState } from "./lib/voiceStreams.js";
import {
  DEFAULT_VOLUME_PERCENT,
  clampVolumePercent,
  pruneVolumes,
  readUserVolumes,
  setVolume,
  writeUserVolumes
} from "./lib/voiceVolume.js";
import {
  DEFAULT_AUDIO_LEVELS,
  combineOutputVolume,
  readAudioLevels,
  writeAudioLevels,
  type AudioLevels
} from "./lib/audioLevels.js";
import { useMicrophoneTest, type MicrophoneTestError } from "./lib/useMicrophoneTest.js";
import {
  claimMicrophoneTestDeafen,
  shouldRestoreMicrophoneTestDeafen,
  type MicrophoneTestDeafenLease
} from "./lib/microphoneTestIsolation.js";
import { loadTurnstile } from "./lib/turnstile.js";
import { startupSurface } from "./lib/startupSurface.js";
import { createAuthRequestGate } from "./lib/authRequestGate.js";
import { groupDirectoryMembers } from "./lib/memberDirectory.js";
import { renameMessagesForServer, replacePresenceUser } from "./lib/memberIdentity.js";
import { voiceChannelActivation } from "./lib/voiceChannelActivation.js";
import {
  clearUnread,
  readRoomHistory,
  rememberRoom,
  roomsForServer,
  resolveRememberedRoom,
  resolveServerTextRoom,
  unreadAfterMessage,
  writeRoomHistory,
  type RoomHistory
} from "./lib/channelState.js";
import { AppShellSkeleton } from "./components/AppShellSkeleton.js";
import { AudioDeviceSettings } from "./components/AudioDeviceSettings.js";
import { LiveStreamPopover } from "./components/LiveStreamPopover.js";
import { ContextMenu } from "./components/ContextMenu.js";
import { ServerSwitcher } from "./components/ServerSwitcher.js";
import { useAudioDevices, type UseAudioDevicesResult } from "./lib/useAudioDevices.js";
import {
  languageLabel,
  readLanguageChoice,
  saveLanguageChoice,
  translate,
  type LanguageCode,
  type TranslationKey
} from "./lib/i18n.js";

type Route =
  | { name: "landing" }
  | { name: "invite"; token: string }
  | { name: "owner-claim"; token: string }
  | { name: "access-claim"; token: string }
  | { name: "text"; serverId: string; roomId: string }
  | { name: "voice"; serverId: string; roomId: string }
  | { name: "owner"; serverId: string };

type LoadState = "loading" | "ready" | "error";
type ThemeChoice = "auto" | "light" | "dark";
type Drawer = "channels" | "members" | null;
type MemberAction = "disconnect" | "ban" | "kick";
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type LiveWatchRequest = {
  serverId: string;
  roomId: string;
  publisherUserId: string;
  nickname: string;
};
type VoiceJoinRequest = VoiceJoinOptions & { visualTargets?: VisualTarget[] };

const themeKey = "voxly:theme";
const landingPrincipleKeys = ["privateAccess", "selfHosted", "lowFootprint"] as const;
const rtcConfigRetryMs = 10_000;
const publicStunRtcConfig: RtcConfigResponse = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  expiresAt: null
};

export function rtcConfigAfterFetchFailure(current: RtcConfigResponse, hasSuccessfulConfig: boolean) {
  return hasSuccessfulConfig ? current : publicStunRtcConfig;
}

export function AuthenticatedAppSurface({ audio, children, connectionHealth, t }: {
  audio: ReactNode;
  children: ReactNode;
  connectionHealth?: ConnectionHealth;
  t?: Translate;
}) {
  const blocked = Boolean(connectionHealth?.overlayVisible);
  return <>{audio}<div className="authenticated-surface" inert={blocked ? true : undefined}>{children}</div>{blocked && connectionHealth && t ? <ReconnectOverlay health={connectionHealth} t={t} /> : null}</>;
}

export function joinVoiceWithAudioUnlock(
  roomId: string,
  unlock: () => void,
  release: () => void,
  join: (roomId: string) => Promise<boolean>
) {
  unlock();
  return join(roomId).then((joined) => {
    if (!joined) release();
    return joined;
  }, (cause: unknown) => {
    release();
    throw cause;
  });
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authState, setAuthState] = useState<LoadState>("loading");
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [serverListReady, setServerListReady] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const [roomHistory, setRoomHistory] = useState<RoomHistory>(() => readRoomHistory(window.localStorage));
  const [onlineUsersByServer, setOnlineUsersByServer] = useState<Record<string, PresenceUser[]>>({});
  const [serverMembersByServer, setServerMembersByServer] = useState<Record<string, PresenceUser[]>>({});
  const [socketState, setSocketState] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [socketInstance, setSocketInstance] = useState<VoxlySocket | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfigResponse>({ publicUrl: null, turnstile: null });
  const [rtcConfig, setRtcConfig] = useState<RtcConfigResponse>({ iceServers: [], expiresAt: null });
  const [rtcConfigReady, setRtcConfigReady] = useState(false);
  const [rtcConfigError, setRtcConfigError] = useState("");
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [theme, setTheme] = useState<ThemeChoice>(() => readThemeChoice());
  const [language, setLanguage] = useState<LanguageCode>(() => readLanguageChoice());
  const socketRef = useRef<VoxlySocket | null>(null);
  const authRequestGateRef = useRef(createAuthRequestGate());
  const authenticatedUserIdRef = useRef<string | null>(null);
  const routeRef = useRef(route);
  const activeTextRoomIdRef = useRef<string | null>(route.name === "text" ? route.roomId : null);
  const roomServerIdsRef = useRef<Record<string, string>>({});
  const indexRooms = useCallback((nextRooms: RoomSummary[]) => {
    for (const room of nextRooms) roomServerIdsRef.current[room.id] = room.serverId;
  }, []);
  const t = useCallback<Translate>((key, values) => translate(language, key, values), [language]);
  const activeServerId = route.name === "text" || route.name === "voice" || route.name === "owner"
    ? route.serverId
    : servers[0]?.id ?? defaultServerId;
  const onlineUsers = onlineUsersByServer[activeServerId] ?? (user ? [presenceFromUser(user)] : []);
  const serverMembers = serverMembersByServer[activeServerId] ?? [];
  const activeRooms = useMemo(() => roomsForServer(rooms, activeServerId), [activeServerId, rooms]);
  const currentRoom = useMemo(() => activeRooms.find((room) => {
    if (route.name === "text" || route.name === "voice") {
      return room.id === route.roomId && room.serverId === route.serverId;
    }
    return false;
  }), [activeRooms, route]);
  const voiceRoomIds = useMemo(() => activeRooms.filter((room) => room.kind === "voice").map((room) => room.id), [activeRooms]);
  const audioDevices = useAudioDevices({ userId: user?.id });
  const [audioLevels, setAudioLevels] = useState<AudioLevels>(DEFAULT_AUDIO_LEVELS);
  const voice = useVoiceMedia({
    socket: socketInstance,
    user,
    iceServers: rtcConfig.iceServers,
    voiceRoomIds,
    microphoneDeviceId: audioDevices.selectedInputId,
    microphoneVolume: audioLevels.input
  });
  const connectionHealth = useConnectionHealth(socketInstance);
  const microphoneTest = useMicrophoneTest(audioDevices.selectedInputId, audioLevels.input, voice.microphoneMonitorStream);
  const microphoneTestDeafenRef = useRef<MicrophoneTestDeafenLease | null>(null);
  const activeVoiceRoomRef = useRef<string | null>(voice.activeRoomId);
  const leaveVoiceRef = useRef<() => void>(voice.leave);
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
  const [pendingLiveWatch, setPendingLiveWatch] = useState<LiveWatchRequest | null>(null);
  const renderSurface = (surface: ReactNode) => user ? (
    <AuthenticatedAppSurface
      connectionHealth={connectionHealth}
      t={t}
      audio={(
        <>
          <GlobalVoiceAudio
            streams={voice.remoteStreams}
            muted={voice.controls.deafen.on || voice.voiceModeration.deafened}
            mutedUserIds={new Set((voice.activeRoomId ? voice.voiceSnapshots[voice.activeRoomId]?.members : [])?.filter((member) => member.moderation.muted).map((member) => member.user.userId) ?? [])}
            memberVolumes={memberVolumes}
            outputVolume={audioLevels.output}
          />
          {microphoneTest.monitorStream ? <RemoteAudio
            stream={microphoneTest.monitorStream}
            muted={false}
            volume={combineOutputVolume(DEFAULT_VOLUME_PERCENT, audioLevels.output)}
          /> : null}
          {audioPlaybackBlocked ? <AudioPlaybackRecovery t={t} /> : null}
        </>
      )}
    >
      {surface}
    </AuthenticatedAppSurface>
  ) : surface;

  useEffect(() => {
    if (!voice.activeRoomId) return;
    void audioDevices.refresh(false).catch(() => undefined);
  }, [audioDevices.refresh, voice.activeRoomId]);

  useEffect(() => subscribeBlockedAudioOutputs(setAudioPlaybackBlocked), []);

  useEffect(() => {
    activeVoiceRoomRef.current = voice.activeRoomId;
    leaveVoiceRef.current = voice.leave;
  }, [voice.activeRoomId, voice.leave]);

  useEffect(() => {
    setMemberVolumes(user ? readUserVolumes(user.id) : {});
  }, [user?.id]);

  useEffect(() => {
    setAudioLevels(user ? readAudioLevels(user.id) : { ...DEFAULT_AUDIO_LEVELS });
  }, [user?.id]);

  const changeAudioLevel = useCallback((kind: keyof AudioLevels, volume: number) => {
    setAudioLevels((current) => {
      const next = { ...current, [kind]: clampVolumePercent(volume) };
      if (user) writeAudioLevels(user.id, next);
      return next;
    });
  }, [user?.id]);

  const isolateMicrophoneTest = useCallback(async () => {
    const roomId = voice.activeRoomId;
    if (!roomId) {
      microphoneTestDeafenRef.current = null;
      return true;
    }
    if (microphoneTestDeafenRef.current?.roomId === roomId) return true;
    const claim = claimMicrophoneTestDeafen(roomId, voice.controls.deafen.on);
    if (claim.shouldDeafen && !(await voice.setDeafened(true))) return false;
    microphoneTestDeafenRef.current = claim.lease;
    return true;
  }, [voice.activeRoomId, voice.controls.deafen.on, voice.setDeafened]);

  const stopMicrophoneTest = useCallback(async () => {
    microphoneTest.stop();
    const lease = microphoneTestDeafenRef.current;
    microphoneTestDeafenRef.current = null;
    if (shouldRestoreMicrophoneTestDeafen(lease, voice.activeRoomId)) {
      await voice.setDeafened(false);
    }
  }, [microphoneTest.stop, voice.activeRoomId, voice.setDeafened]);

  const startMicrophoneTest = useCallback(async () => {
    if (!(await isolateMicrophoneTest())) return;
    if (await microphoneTest.start()) return;
    await stopMicrophoneTest();
  }, [isolateMicrophoneTest, microphoneTest.start, stopMicrophoneTest]);

  const toggleMicrophoneTest = useCallback(async () => {
    if (microphoneTest.active) await stopMicrophoneTest();
    else await startMicrophoneTest();
  }, [microphoneTest.active, startMicrophoneTest, stopMicrophoneTest]);

  useEffect(() => {
    if (!microphoneTest.active) return;
    if (!voice.activeRoomId) {
      microphoneTestDeafenRef.current = null;
      return;
    }
    if (microphoneTestDeafenRef.current?.roomId === voice.activeRoomId) return;
    void isolateMicrophoneTest().then((isolated) => {
      if (!isolated) microphoneTest.stop();
    });
  }, [isolateMicrophoneTest, microphoneTest.active, microphoneTest.stop, voice.activeRoomId]);

  useEffect(() => {
    const activeScreenIds = voice.remoteStreams
      .filter((item) => item.kind === "screen")
      .map((item) => item.stream.id);
    setScreenVolumes((current) => pruneVolumes(current, activeScreenIds));
  }, [voice.remoteStreams]);

  const changeMemberVolume = useCallback((remoteUserId: string, volume: number) => {
    if (!user) return;
    setMemberVolumes((current) => {
      const next = setVolume(current, remoteUserId, volume);
      writeUserVolumes(user.id, next);
      return next;
    });
  }, [user]);

  const changeScreenVolume = useCallback((streamId: string, volume: number) => {
    setScreenVolumes((current) => setVolume(current, streamId, volume));
  }, []);

  const refreshServerDirectory = useCallback((serverId: string) => {
    return fetchServerDirectory(serverId).then((response) => {
      setServerMembersByServer((current) => ({ ...current, [serverId]: response.members }));
    });
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    const nextRoute = parseRoute(path);
    routeRef.current = nextRoute;
    setRoute(nextRoute);
    setDrawer(null);
  }, []);

  const refreshRoomsAfterDeletion = useCallback(async (serverId: string, deletedRoomId: string) => {
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

  const completeAuthentication = useCallback((nextUser: PublicUser) => {
    authRequestGateRef.current.invalidate();
    if (authenticatedUserIdRef.current !== nextUser.id) setRtcConfigReady(false);
    authenticatedUserIdRef.current = nextUser.id;
    setUser(nextUser);
    setAuthState("ready");
  }, []);

  const handleOwnerClaimed = useCallback((claimedUser: PublicUser) => {
    completeAuthentication(claimedUser);
    navigate(`/app/server/${defaultServerId}/owner`);
  }, [completeAuthentication, navigate]);

  const handleAccessClaimed = useCallback((claimedUser: PublicUser, serverId: string) => {
    completeAuthentication(claimedUser);
    void Promise.all([fetchServers(), fetchServerRooms(serverId)])
      .then(([serverResponse, roomResponse]) => {
        setServers(serverResponse.servers);
        indexRooms(roomResponse.rooms);
        setRooms(roomResponse.rooms);
        navigate(firstServerRoomPath(serverId, roomResponse.rooms));
      })
      .catch(() => navigate("/"));
  }, [completeAuthentication, indexRooms, navigate]);

  useEffect(() => {
    const handlePop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  useEffect(() => {
    routeRef.current = route;
    activeTextRoomIdRef.current = route.name === "text" ? route.roomId : null;
    if (route.name !== "text" && route.name !== "voice") return;

    if (route.name === "text") {
      setUnreadByRoom((current) => clearUnread(current, route.roomId));
    }
    setRoomHistory((current) => {
      const next = rememberRoom(current, route.serverId, route.name, route.roomId);
      writeRoomHistory(window.localStorage, next);
      return next;
    });
  }, [route]);

  useEffect(() => {
    applyThemeChoice(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    let isMounted = true;
    fetchConfig()
      .then((config) => {
        if (isMounted) setAppConfig(config);
      })
      .catch(() => {
        if (isMounted) setAppConfig({ publicUrl: null, turnstile: null });
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setRtcConfig({ iceServers: [], expiresAt: null });
      setRtcConfigError("");
      setRtcConfigReady(true);
      return;
    }
    setRtcConfigReady(false);
    setRtcConfig({ iceServers: [], expiresAt: null });
    setRtcConfigError("");
    let cancelled = false;
    let hasSuccessfulConfig = false;
    let refreshTimer: number | null = null;
    const load = async () => {
      try {
        const config = await fetchRtcConfig();
        if (cancelled) return;
        hasSuccessfulConfig = true;
        setRtcConfig(config);
        setRtcConfigError("");
        if (config.expiresAt) {
          const refreshInMs = Math.max(60_000, config.expiresAt * 1000 - Date.now() - 5 * 60_000);
          refreshTimer = window.setTimeout(() => void load(), refreshInMs);
        }
      } catch {
        if (!cancelled) {
          setRtcConfig((current) => rtcConfigAfterFetchFailure(current, hasSuccessfulConfig));
          setRtcConfigError("RTC connection configuration could not be loaded. Retrying.");
          refreshTimer = window.setTimeout(() => void load(), rtcConfigRetryMs);
        }
      } finally {
        if (!cancelled) setRtcConfigReady(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [user?.id]);

  useEffect(() => {
    let isMounted = true;
    const requestGeneration = authRequestGateRef.current.begin();
    setAuthState("loading");
    fetchMe()
      .then((response) => {
        if (!isMounted || !authRequestGateRef.current.isCurrent(requestGeneration)) return;
        setRtcConfigReady(false);
        authenticatedUserIdRef.current = response.user.id;
        setUser(response.user);
        setAuthState("ready");
      })
      .catch((error: unknown) => {
        if (!isMounted || !authRequestGateRef.current.isCurrent(requestGeneration)) return;
        if (error instanceof ApiError && error.status === 401) {
          authenticatedUserIdRef.current = null;
          setUser(null);
          setAuthState("ready");
          if (route.name !== "landing" && route.name !== "invite" && route.name !== "owner-claim" && route.name !== "access-claim") {
            navigate(resolveInitialRoute({ isAuthenticated: false, inviteToken: getInviteTokenFromPath(window.location.pathname) || null }));
          }
          return;
        }
        setAuthState("error");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setServerListReady(false);
      return;
    }

    let isMounted = true;
    setServerListReady(false);
    fetchServers()
      .then((response) => {
        if (!isMounted) return;
        setServers(response.servers);
        setServerListReady(true);
        if (route.name === "landing" && response.servers[0]) {
          void fetchServerRooms(response.servers[0].id).then((roomsResponse) => {
            const target = roomsResponse.rooms.find((room) => room.kind === "text") ?? roomsResponse.rooms[0];
            if (target && isMounted) navigate(`/app/server/${response.servers[0].id}/${target.kind}/${target.id}`);
          });
        }
      })
      .catch(() => {
        if (isMounted) {
          setServers([]);
          setServerListReady(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [navigate, route.name, user]);

  useEffect(() => {
    if (!user || !activeServerId) return;
    let isMounted = true;
    fetchServerRooms(activeServerId)
      .then((response) => {
        if (isMounted) {
          indexRooms(response.rooms);
          setRooms(response.rooms);
        }
      })
      .catch(() => {
        if (isMounted) setRooms([]);
      });
    fetchServerDirectory(activeServerId)
      .then((response) => {
        if (isMounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: response.members }));
      })
      .catch(() => {
        if (isMounted) setServerMembersByServer((current) => ({ ...current, [activeServerId]: [] }));
      });
    return () => {
      isMounted = false;
    };
  }, [activeServerId, indexRooms, user]);

  useEffect(() => {
    if (route.name !== "owner") return;
    const membership = servers.find((server) => server.id === route.serverId);
    if (membership?.role === "owner" || !serverListReady) return;
    let cancelled = false;
    const fallbackServerId = membership?.id ?? servers[0]?.id;
    if (!fallbackServerId) {
      navigate("/invite");
      return;
    }
    void fetchServerRooms(fallbackServerId).then((response) => {
      if (cancelled) return;
      const target = response.rooms.find((room) => room.kind === "text") ?? response.rooms[0];
      if (target) navigate(serverPath(fallbackServerId, target.kind, target.id));
      else navigate("/invite");
    }).catch(() => {
      if (!cancelled) navigate("/invite");
    });
    return () => {
      cancelled = true;
    };
  }, [navigate, route, serverListReady, servers]);

  useEffect(() => {
    if (!user || route.name !== "text" || currentRoom?.kind !== "text") return;
    let isMounted = true;
    fetchMessages(route.roomId)
      .then((response) => {
        if (isMounted) {
          setMessagesByRoom((current) => ({ ...current, [route.roomId]: response.messages }));
        }
      })
      .catch(() => {
        if (isMounted) {
          setMessagesByRoom((current) => ({ ...current, [route.roomId]: [] }));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [currentRoom, route, user]);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocketInstance(null);
      setOnlineUsersByServer({});
      setServerMembersByServer({});
      return;
    }

    const socket = createVoxlySocket();
    socketRef.current = socket;
    setSocketInstance(socket);
    setSocketState("connecting");

    socket.on("connect", () => setSocketState("live"));
    socket.io.on("reconnect_attempt", () => setSocketState("reconnecting"));
    socket.on("disconnect", () => setSocketState("offline"));
    socket.on("presence:serverSnapshot", ({ serverId, users }) => {
      setOnlineUsersByServer((current) => ({ ...current, [serverId]: includeCurrentPresence(users, user) }));
    });
    socket.on("presence:serverOnline", ({ serverId, user: presenceUser }) => {
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: upsertPresence(current[serverId] ?? [presenceFromUser(user)], presenceUser, user)
      }));
    });
    socket.on("presence:serverOffline", ({ serverId, userId }) => {
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: (current[serverId] ?? []).filter((item) => item.userId !== userId)
      }));
    });
    socket.on("server:directoryChanged", ({ serverId }) => {
      void refreshServerDirectory(serverId).catch(() => undefined);
    });
    socket.on("server:memberUpdated", ({ serverId, user: updatedUser }) => {
      setOnlineUsersByServer((current) => ({
        ...current,
        [serverId]: replacePresenceUser(current[serverId] ?? [], updatedUser)
      }));
      setServerMembersByServer((current) => ({
        ...current,
        [serverId]: replacePresenceUser(current[serverId] ?? [], updatedUser)
      }));
      setMessagesByRoom((current) => renameMessagesForServer(current, roomServerIdsRef.current, serverId, updatedUser));
    });
    socket.on("server:updated", ({ serverId, name }) => {
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, name } : server));
    });
    socket.on("server:roomsChanged", ({ serverId, deletedRoomId }) => {
      void refreshRoomsAfterDeletion(serverId, deletedRoomId).catch(() => undefined);
    });
    socket.on("server:deleted", ({ serverId }) => {
      void refreshServersAfterDeletion(serverId).catch(() => undefined);
    });
    socket.on("message:new", (message) => {
      setMessagesByRoom((current) => ({
        ...current,
        [message.roomId]: upsertMessage(current[message.roomId] ?? [], message)
      }));
      setUnreadByRoom((current) => unreadAfterMessage(current, message, activeTextRoomIdRef.current, user.id));
    });
    socket.on("message:updated", (message) => {
      setMessagesByRoom((current) => ({
        ...current,
        [message.roomId]: upsertMessage(current[message.roomId] ?? [], message)
      }));
    });
    socket.on("message:deleted", ({ roomId, messageId }) => {
      setMessagesByRoom((current) => ({
        ...current,
        [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId)
      }));
    });
    socket.on("voice:forceLeave", ({ roomId }) => {
      if (activeVoiceRoomRef.current === roomId) leaveVoiceRef.current();
    });
    socket.on("server:accessRevoked", ({ serverId }) => {
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
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setSocketInstance(null);
    };
  }, [refreshRoomsAfterDeletion, refreshServerDirectory, refreshServersAfterDeletion, user]);

  useEffect(() => {
    if (!socketInstance || route.name !== "text") return;
    socketInstance.emit("room:join", route.roomId);
    return () => {
      socketInstance.emit("room:leave", route.roomId);
    };
  }, [route, socketInstance]);

  useEffect(() => {
    if (route.name === "voice") {
      voice.requestSnapshot(route.roomId);
    }
  }, [route, voice.requestSnapshot]);

  const roomGroups = useMemo(() => {
    return {
      text: activeRooms.filter((room) => room.kind === "text"),
      voice: activeRooms.filter((room) => room.kind === "voice")
    };
  }, [activeRooms]);

  if (startupSurface(route.name, authState) === "shell-skeleton") {
    return renderSurface(<AppShellSkeleton />);
  }

  if (user && !rtcConfigReady && (route.name === "text" || route.name === "voice" || route.name === "owner")) {
    return renderSurface(<AppShellSkeleton />);
  }

  if (authState === "error" && (route.name === "text" || route.name === "voice" || route.name === "owner")) {
    return renderSurface(<FatalState t={t} />);
  }

  if (route.name === "owner-claim") {
    return renderSurface(
      <OwnerClaimScreen
        token={route.token}
        language={language}
        t={t}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
        onClaimed={handleOwnerClaimed}
      />
    );
  }

  if (route.name === "access-claim") {
    return renderSurface(<AccessClaimScreen token={route.token} t={t} onNavigate={navigate} onClaimed={handleAccessClaimed} />);
  }

  if (!user && route.name === "landing") {
    return (
      <LandingPage
        language={language}
        t={t}
        onNavigate={navigate}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
      />
    );
  }

  if (!user && route.name === "invite" && !route.token) {
    return (
      <InviteRequiredScreen
        language={language}
        t={t}
        onNavigate={navigate}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
      />
    );
  }

  if (!user || route.name === "invite") {
    return renderSurface(
      <InviteScreen
        initialToken={route.name === "invite" ? route.token : ""}
        existingUser={Boolean(user)}
        currentUser={user}
        turnstileSiteKey={appConfig.turnstile?.siteKey ?? null}
        language={language}
        t={t}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
        onAccepted={(acceptedUser, serverId) => {
          completeAuthentication(acceptedUser);
          void Promise.all([fetchServers(), fetchServerRooms(serverId)]).then(([serverResponse, roomResponse]) => {
            setServers(serverResponse.servers);
            const target = roomResponse.rooms.find((room) => room.kind === "text") ?? roomResponse.rooms[0];
            if (target) navigate(`/app/server/${serverId}/${target.kind}/${target.id}`);
          });
        }}
      />
    );
  }

  const currentNickname = serverMembers.find((member) => member.userId === user.id)?.nickname
    ?? onlineUsers.find((member) => member.userId === user.id)?.nickname
    ?? user.nickname;
  const shellProps = {
    user,
    currentNickname: currentNickname,
    route,
    servers,
    activeServerId,
    rooms: roomGroups,
    onlineUsers,
    serverMembers,
    socketState,
    connectionHealth,
    activeVoiceRoomId: voice.activeRoomId,
    controls: voice.controls,
    voiceModeration: voice.voiceModeration,
    drawer,
    theme,
    language,
    t,
    currentRoom,
    appConfig,
    voiceError: voice.error || rtcConfigError,
    visualTargets: voice.visualTargets,
    voiceSnapshots: voice.voiceSnapshots,
    remoteStreams: voice.remoteStreams,
    peerConnectionStates: voice.peerConnectionStates,
    localPreviews: voice.localPreviews,
    memberVolumes,
    screenVolumes,
    unreadByRoom,
    roomHistory,
    pendingLiveWatch,
    audioDevices,
    audioLevels,
    microphoneTestActive: microphoneTest.active,
    microphoneTestError: microphoneTest.error,
    onNavigate: navigate,
    onSelectServer: async (serverId: string) => {
      const response = await fetchServerRooms(serverId);
      const textRooms = response.rooms.filter((room) => room.kind === "text");
      const target = resolveRememberedRoom(textRooms, roomHistory[serverId]?.text) ?? response.rooms[0];
      if (target) navigate(serverPath(serverId, target.kind, target.id));
    },
    onCreateServer: async (name: string) => {
      const response = await createServer(name);
      setServers((current) => [...current, response.server]);
      const roomsResponse = await fetchServerRooms(response.server.id);
      const target = roomsResponse.rooms.find((room) => room.kind === "text") ?? roomsResponse.rooms[0];
      if (target) navigate(serverPath(response.server.id, target.kind, target.id));
    },
    onUpdateServerName: async (name: string) => {
      const response = await updateServer(activeServerId, name);
      setServers((current) => current.map((server) => server.id === activeServerId ? response.server : server));
      return response.server;
    },
    onCreateRoom: async (name: string, kind: "text" | "voice") => {
      const response = await createServerRoom(activeServerId, name, kind);
      roomServerIdsRef.current[response.room.id] = response.room.serverId;
      setRooms((current) => [...current, response.room].sort((left, right) => left.position - right.position));
      navigate(serverPath(activeServerId, response.room.kind, response.room.id));
    },
    onDeleteRoom: async (roomId: string) => {
      await deleteServerRoom(activeServerId, roomId);
      await refreshRoomsAfterDeletion(activeServerId, roomId);
    },
    onDeleteServer: async () => {
      const deletedServerId = activeServerId;
      await deleteServer(deletedServerId);
      await refreshServersAfterDeletion(deletedServerId);
    },
    onModerateMember: async (userId: string, action: "ban" | "unban" | "kick") => {
      await moderateServerMember(activeServerId, userId, action);
      await refreshServerDirectory(activeServerId);
    },
    onVoiceModeration: async (userId: string, moderation: Partial<VoiceModerationState>) => {
      return updateVoiceModeration(activeServerId, userId, moderation);
    },
    onUpdateMemberNickname: async (userId: string, nickname: string) => {
      const response = await updateServerMemberNickname(activeServerId, userId, nickname);
      const updatedUser = response.user;
      setOnlineUsersByServer((current) => ({
        ...current,
        [activeServerId]: replacePresenceUser(current[activeServerId] ?? [], updatedUser)
      }));
      setServerMembersByServer((current) => ({
        ...current,
        [activeServerId]: replacePresenceUser(current[activeServerId] ?? [], updatedUser)
      }));
      setMessagesByRoom((current) => renameMessagesForServer(
        current,
        roomServerIdsRef.current,
        activeServerId,
        updatedUser
      ));
      return updatedUser;
    },
    onDisconnectMember: async (roomId: string, userId: string) => {
      await disconnectVoiceMember(activeServerId, roomId, userId);
    },
    onDrawerChange: setDrawer,
    onThemeChange: (nextTheme: ThemeChoice) => {
      saveThemeChoice(nextTheme);
      setTheme(nextTheme);
    },
    onLanguageChange: (nextLanguage: LanguageCode) => {
      saveLanguageChoice(nextLanguage);
      setLanguage(nextLanguage);
    },
    onJoinVoice: (roomId: string, options: VoiceJoinRequest = {}) => joinVoiceWithAudioUnlock(
      roomId,
      unlockSharedAudioOutput,
      releaseUnusedSharedAudioOutput,
      (nextRoomId) => voice.join(nextRoomId, options.visualTargets ?? [], options)
    ),
    onWatchLive: (request: LiveWatchRequest) => {
      setPendingLiveWatch(request);
      navigate(serverPath(request.serverId, "voice", request.roomId));
    },
    onLiveWatchHandled: () => setPendingLiveWatch(null),
    onRequestVoiceSnapshot: voice.requestSnapshot,
    onSetVisualSubscriptions: voice.setVisualSubscriptions,
    onMemberVolumeChange: changeMemberVolume,
    onScreenVolumeChange: changeScreenVolume,
    onInputVolumeChange: (volume: number) => changeAudioLevel("input", volume),
    onOutputVolumeChange: (volume: number) => changeAudioLevel("output", volume),
    onToggleMicrophoneTest: toggleMicrophoneTest,
    onCloseAudioSettings: () => { void stopMicrophoneTest(); },
    onToggleControl: voice.toggleControl,
    onLeaveVoice: voice.leave,
    onLogout: async () => {
      voice.leave();
      await logout();
      authRequestGateRef.current.invalidate();
      authenticatedUserIdRef.current = null;
      setUser(null);
      setAuthState("ready");
      navigate("/invite");
    }
  };

  if (route.name === "owner" && servers.find((server) => server.id === route.serverId)?.role !== "owner") {
    return renderSurface(<AppShellSkeleton />);
  }

  if (route.name === "owner") {
    return renderSurface(<OwnerPanel {...shellProps} />);
  }

  if (route.name === "voice") {
    return renderSurface(<VoiceRoomScreen {...shellProps} />);
  }

  if (route.name !== "text") {
    return renderSurface(<AppShellSkeleton />);
  }

  return renderSurface(
    <TextRoomScreen
      {...shellProps}
      messages={messagesByRoom[route.roomId] ?? []}
      onSendMessage={async (body) => {
        const response = await sendMessage(route.roomId, body);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: upsertMessage(current[route.roomId] ?? [], response.message)
        }));
      }}
      onUpdateMessage={async (messageId, body) => {
        const response = await updateMessage(route.roomId, messageId, body);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: upsertMessage(current[route.roomId] ?? [], response.message)
        }));
      }}
      onDeleteMessage={async (messageId) => {
        await deleteMessage(route.roomId, messageId);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: (current[route.roomId] ?? []).filter((message) => message.id !== messageId)
        }));
      }}
      onSuppressEmbed={async (messageId, embedKey) => {
        const response = await suppressMessageEmbed(route.roomId, messageId, embedKey);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: upsertMessage(current[route.roomId] ?? [], response.message)
        }));
      }}
    />
  );
}

function LandingPage({ language, t, onLanguageChange, onNavigate }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  return (
    <main className="landing-page">
      <header className="landing-nav" style={{ viewTransitionName: "persistent-nav" }}>
        <BrandLockup subtitle={t("landing.brandSubtitle")} href="/" onNavigate={onNavigate} />
        <nav className="landing-nav-actions" aria-label={t("landing.nav")}>
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <NavLink className="btn btn-ghost" href="/invite" onNavigate={onNavigate}>
            <span>{t("landing.haveInvite")}</span>
          </NavLink>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="label">{t("landing.label")}</p>
          <h1>{t("landing.title")}</h1>
          <p className="landing-copy">{t("landing.copy")}</p>
          <div className="landing-actions">
            <NavLink className="btn btn-primary" href="/invite" onNavigate={onNavigate}>
              <ArrowIcon />
              <span>{t("landing.inviteCta")}</span>
            </NavLink>
          </div>
        </div>
        <div className="landing-signal" aria-hidden="true">
          <span className="landing-signal-ring landing-signal-ring-one" />
          <span className="landing-signal-ring landing-signal-ring-two" />
          <span className="landing-signal-ring landing-signal-ring-three" />
          <span className="landing-signal-core"><img src="/brand/logo-mark.svg" alt="" width="54" height="54" /></span>
        </div>
      </section>

      <ul className="landing-principles" aria-label={t("landing.features")}>
        {landingPrincipleKeys.map((key) => (
          <li key={key}>{t(`landing.${key}.title` as TranslationKey)}</li>
        ))}
      </ul>
    </main>
  );
}

function InviteRequiredScreen({ language, t, onLanguageChange, onNavigate }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{t("invite.missingTitle")}</h1>
            <p className="muted small">{t("invite.missingCopy")}</p>
          </div>
          <div className="invite-status is-loading" aria-live="polite">
            <strong>{t("invite.linkRequired")}</strong>
            <span className="muted small">{t("invite.askOwner")}</span>
          </div>
          <NavLink className="btn btn-primary full-width" href="/" onNavigate={onNavigate}>
            <ArrowIcon />
            <span>{t("invite.backToHome")}</span>
          </NavLink>
        </section>
      </div>
    </main>
  );
}

interface ShellProps {
  user: PublicUser;
  currentNickname: string;
  route: Route;
  servers: ServerSummary[];
  activeServerId: string;
  rooms: { text: RoomSummary[]; voice: RoomSummary[] };
  onlineUsers: PresenceUser[];
  serverMembers: PresenceUser[];
  socketState: "connecting" | "live" | "reconnecting" | "offline";
  connectionHealth: ConnectionHealth;
  activeVoiceRoomId: string | null;
  controls: VoiceControls;
  voiceModeration: VoiceModerationState;
  appConfig: AppConfigResponse;
  voiceError: string;
  visualTargets: VisualTarget[];
  voiceSnapshots: Record<string, VoiceSnapshot>;
  remoteStreams: RemoteStreamState[];
  peerConnectionStates: Record<string, PeerConnectionState>;
  localPreviews: Array<{ kind: "camera" | "screen"; stream: MediaStream }>;
  memberVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  unreadByRoom: Record<string, number>;
  roomHistory: RoomHistory;
  pendingLiveWatch: LiveWatchRequest | null;
  audioDevices: UseAudioDevicesResult;
  audioLevels: AudioLevels;
  microphoneTestActive: boolean;
  microphoneTestError: MicrophoneTestError;
  drawer: Drawer;
  theme: ThemeChoice;
  language: LanguageCode;
  t: Translate;
  currentRoom: RoomSummary | undefined;
  onNavigate: (path: string) => void;
  onSelectServer: (serverId: string) => Promise<void>;
  onCreateServer: (name: string) => Promise<void>;
  onUpdateServerName: (name: string) => Promise<ServerSummary>;
  onCreateRoom: (name: string, kind: "text" | "voice") => Promise<void>;
  onDeleteRoom: (roomId: string) => Promise<void>;
  onDeleteServer: () => Promise<void>;
  onModerateMember: (userId: string, action: "ban" | "unban" | "kick") => Promise<void>;
  onVoiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) => Promise<{ moderation: VoiceModerationState }>;
  onUpdateMemberNickname: (userId: string, nickname: string) => Promise<PresenceUser>;
  onDisconnectMember: (roomId: string, userId: string) => Promise<void>;
  onDrawerChange: (drawer: Drawer) => void;
  onThemeChange: (theme: ThemeChoice) => void;
  onLanguageChange: (language: LanguageCode) => void;
  onJoinVoice: (roomId: string, options?: VoiceJoinRequest) => Promise<boolean>;
  onWatchLive: (request: LiveWatchRequest) => void;
  onLiveWatchHandled: () => void;
  onRequestVoiceSnapshot: (roomId: string) => void;
  onSetVisualSubscriptions: (targets: VisualTarget[]) => Promise<VisualSubscriptionResult>;
  onMemberVolumeChange: (userId: string, volume: number) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  onInputVolumeChange: (volume: number) => void;
  onOutputVolumeChange: (volume: number) => void;
  onToggleMicrophoneTest: () => Promise<void>;
  onCloseAudioSettings: () => void;
  onToggleControl: (key: keyof VoiceControls) => void;
  onLeaveVoice: () => void;
  onLogout: () => Promise<void>;
}

function TextRoomScreen(props: ShellProps & {
  messages: ChatMessage[];
  onSendMessage: (body: string) => Promise<void>;
  onUpdateMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const listRef = useRef<HTMLElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const previousMessageIdsRef = useRef<string[]>([]);
  const roomId = props.currentRoom?.id;
  const targetVoiceRoom = resolveRememberedRoom(
    props.rooms.voice,
    props.roomHistory[props.activeServerId]?.voice
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  useLayoutEffect(() => {
    previousMessageIdsRef.current = props.messages.map((message) => message.id);
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
    scrollToLatest("auto");
  }, [roomId, scrollToLatest]);

  useLayoutEffect(() => {
    const currentIds = props.messages.map((message) => message.id);
    const action = messageListUpdateAction(
      previousMessageIdsRef.current,
      currentIds,
      wasNearBottomRef.current
    );
    previousMessageIdsRef.current = currentIds;
    if (action === "scroll") scrollToLatest("auto");
    if (action === "notify") setHasNewMessages(true);
  }, [props.messages, scrollToLatest]);

  function handleListScroll() {
    const list = listRef.current;
    if (!list) return;
    const isNearBottom = isMessageListNearBottom(list);
    wasNearBottomRef.current = isNearBottom;
    if (isNearBottom) setHasNewMessages(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError(props.t("room.writeBeforeSending"));
      return;
    }

    setError("");
    setIsSending(true);
    try {
      await props.onSendMessage(body);
      setDraft("");
    } catch {
      setError(props.t("room.messageCouldNotSend"));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <AppChrome {...props} mobileTitle={props.currentRoom?.name ?? "Text room"}>
      <main className="main-panel" id="main-content">
        <RoomHeader
          title={`#${props.currentRoom?.name ?? "lobby"}`}
          subtitle={props.t("room.generalTalk")}
          actionLabel={targetVoiceRoom ? props.t("room.openChannel", { channel: targetVoiceRoom.name }) : undefined}
          onAction={targetVoiceRoom ? () => props.onNavigate(serverPath(props.activeServerId, "voice", targetVoiceRoom.id)) : undefined}
        />
        <div className="message-viewport">
          <section className="message-list" ref={listRef} aria-label={props.t("room.messages")} onScroll={handleListScroll}>
            <div className="message-day">{props.t("room.today")}</div>
            {props.messages.length === 0 ? (
              <EmptyState title={props.t("room.noMessages")} copy={props.t("room.noMessagesCopy")} />
            ) : (
              props.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  user={props.user}
                  language={props.language}
                  t={props.t}
                  onUpdate={props.onUpdateMessage}
                  onDelete={props.onDeleteMessage}
                  onSuppressEmbed={props.onSuppressEmbed}
                />
              ))
            )}
          </section>
          {hasNewMessages ? (
            <button className="new-messages-indicator" type="button" onClick={() => scrollToLatest()}>
              {props.t("room.newMessages")}
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
        <footer className="composer">
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="messageInput">
              <span className="label">{props.t("room.messageLabel", { room: props.currentRoom?.name ?? "lobby" })}</span>
              <textarea
                className="textarea"
                id="messageInput"
                value={draft}
                name="message"
                placeholder={props.t("room.chatPlaceholder")}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (!shouldSubmitComposer({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing,
                    isSending
                  })) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={isSending}>
              <ArrowIcon />
              <span>{isSending ? props.t("common.sending") : props.t("common.send")}</span>
            </button>
          </form>
          <p className="error-text" aria-live="polite">{error}</p>
        </footer>
      </main>
    </AppChrome>
  );
}

interface StageSource {
  key: string;
  kind: VisualMediaKind;
  ownerId: string;
  ownerName: string;
  ownerIsLocal: boolean;
  stream: MediaStream | null;
  target: VisualTarget | null;
  connectionStatus: "connecting" | "failed" | "ready";
}

function VoiceRoomScreen(props: ShellProps) {
  const [localStageKeys, setLocalStageKeys] = useState<string[]>([]);
  const [focusedSourceKey, setFocusedSourceKey] = useState<string | null>(null);
  const [stageStatus, setStageStatus] = useState("");
  const liveWatchAttemptRef = useRef<LiveWatchRequest | null>(null);
  const viewedRoomId = props.currentRoom?.id ?? (props.route.name === "voice" ? props.route.roomId : props.activeVoiceRoomId);
  const viewedSnapshot = viewedRoomId ? props.voiceSnapshots[viewedRoomId] : undefined;
  const snapshotMembers = viewedSnapshot?.members ?? [];
  const participants = participantsForViewedRoom(
    viewedSnapshot,
    viewedRoomId,
    props.activeVoiceRoomId,
    presenceFromUser(props.user, props.currentNickname)
  );
  const connectedCount = participants.length;
  const streamByKey = new Map(props.remoteStreams.map((item) => [remoteStreamKey(item.userId, item.kind), item.stream]));
  for (const preview of props.localPreviews) {
    streamByKey.set(remoteStreamKey(props.user.id, preview.kind), preview.stream);
  }
  const mediaByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.media]));
  const moderationByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.moderation]));
  const mediaFor = (userId: string) => userId === props.user.id
    ? {
        mic: props.controls.mic.on,
        camera: props.controls.camera.on,
        screen: props.controls.screenShare.on,
        deafened: props.controls.deafen.on,
        speaking: mediaByUser.get(userId)?.speaking ?? false
      }
    : mediaByUser.get(userId);
  const visualSources: StageSource[] = participants.flatMap((participant) => {
    const media = mediaFor(participant.userId);
    return (["camera", "screen"] as const)
      .filter((kind) => media?.[kind])
      .map((kind) => ({
        key: visualTargetKey({ publisherUserId: participant.userId, kind }),
        kind,
        ownerId: participant.userId,
        ownerName: participant.nickname,
        ownerIsLocal: participant.userId === props.user.id,
        stream: streamByKey.get(remoteStreamKey(participant.userId, kind)) ?? null,
        target: participant.userId === props.user.id ? null : { publisherUserId: participant.userId, kind },
        connectionStatus: participant.userId === props.user.id
          ? "ready"
          : connectionStatusFor(props.peerConnectionStates[participant.userId] ?? "new", Boolean(streamByKey.get(remoteStreamKey(participant.userId, kind))))
      }));
  });
  const pendingLiveWatch = props.pendingLiveWatch?.roomId === viewedRoomId ? props.pendingLiveWatch : null;
  const requestedLiveSource = pendingLiveWatch
    ? visualSources.find((source) => source.ownerId === pendingLiveWatch.publisherUserId && source.kind === "screen") ?? null
    : null;
  const selectedRemoteKeys = new Set(props.visualTargets.map(visualTargetKey));
  const selectedKeys = new Set([...selectedRemoteKeys, ...localStageKeys]);
  const stageSources = visualSources.filter((source) => selectedKeys.has(source.key));
  const focusedSource = stageSources.find((source) => source.key === focusedSourceKey) ?? stageSources[0] ?? null;
  const hasVoiceActivity = Boolean(props.activeVoiceRoomId || snapshotMembers.length > 0);
  const targetTextRoom = resolveRememberedRoom(
    props.rooms.text,
    props.roomHistory[props.activeServerId]?.text
  );

  const updateRemoteSelection = async (targets: VisualTarget[], focusKey: string) => {
    const response = await props.onSetVisualSubscriptions(targets);
    if (response.ok) {
      setFocusedSourceKey(focusKey);
      setStageStatus("");
      return;
    }
    props.onRequestVoiceSnapshot(viewedRoomId ?? props.activeVoiceRoomId ?? "");
    setStageStatus(props.t("voice.sourceUnavailable"));
  };

  const watchSource = (source: StageSource) => {
    if (
      !source.ownerIsLocal &&
      source.kind === "screen" &&
      viewedRoomId &&
      props.activeVoiceRoomId !== viewedRoomId
    ) {
      props.onWatchLive({
        serverId: props.activeServerId,
        roomId: viewedRoomId,
        publisherUserId: source.ownerId,
        nickname: source.ownerName
      });
      return;
    }
    if (source.ownerIsLocal) {
      setLocalStageKeys([source.key]);
      setFocusedSourceKey(source.key);
      return;
    }
    if (source.target) void updateRemoteSelection(replaceVisualTarget(props.visualTargets, source.target), source.key);
  };

  const toggleSource = (source: StageSource) => {
    if (source.ownerIsLocal) {
      setLocalStageKeys((current) => current.includes(source.key)
        ? current.filter((key) => key !== source.key)
        : [...current, source.key]);
      setFocusedSourceKey(source.key);
      return;
    }
    if (source.target) void updateRemoteSelection(toggleVisualTarget(props.visualTargets, source.target), source.key);
  };

  useEffect(() => {
    if (!pendingLiveWatch) {
      liveWatchAttemptRef.current = null;
      return;
    }
    if (props.socketState !== "live" || !viewedRoomId || props.activeVoiceRoomId === viewedRoomId || !requestedLiveSource) return;
    if (liveWatchAttemptRef.current === pendingLiveWatch) return;
    liveWatchAttemptRef.current = pendingLiveWatch;
    setStageStatus("");
    void props.onJoinVoice(viewedRoomId, {
      microphoneEnabled: true,
      visualTargets: [{ publisherUserId: pendingLiveWatch.publisherUserId, kind: "screen" }]
    }).catch(() => {
      if (liveWatchAttemptRef.current === pendingLiveWatch) liveWatchAttemptRef.current = null;
      setStageStatus(props.t("voice.sourceUnavailable"));
    });
  }, [pendingLiveWatch, props.activeVoiceRoomId, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  useEffect(() => {
    if (!pendingLiveWatch || props.socketState !== "live" || props.activeVoiceRoomId !== viewedRoomId || !requestedLiveSource) return;
    if (requestedLiveSource.ownerIsLocal) {
      setLocalStageKeys([requestedLiveSource.key]);
      setFocusedSourceKey(requestedLiveSource.key);
      props.onLiveWatchHandled();
      return;
    }
    if (!requestedLiveSource.target) return;
    void updateRemoteSelection([requestedLiveSource.target], requestedLiveSource.key).finally(props.onLiveWatchHandled);
  }, [pendingLiveWatch?.publisherUserId, props.activeVoiceRoomId, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  return (
    <AppChrome {...props} mobileTitle={props.currentRoom?.name ?? props.t("room.lobbyVoice")}>
      <main className="main-panel" id="main-content">
        <RoomHeader
          title={props.currentRoom?.name ?? props.t("room.lobbyVoice")}
          subtitle={props.t("room.pushToMute", { count: connectedCount })}
          actionLabel={targetTextRoom ? props.t("room.openChannel", { channel: targetTextRoom.name }) : undefined}
          onAction={targetTextRoom ? () => props.onNavigate(serverPath(props.activeServerId, "text", targetTextRoom.id)) : undefined}
        />
        {hasVoiceActivity ? (
          <section className="call-surface voice-control-room" aria-label={props.t("room.voiceRooms")}>
            {stageSources.length > 0 ? (
              <VisualStage
                sources={stageSources}
                focusedSource={focusedSource}
                screenVolumes={props.screenVolumes}
                outputVolume={props.audioLevels.output}
                onFocus={setFocusedSourceKey}
                onScreenVolumeChange={props.onScreenVolumeChange}
                t={props.t}
              />
            ) : (
              <section className="stage-empty" aria-live="polite">
                <p className="label">{props.t("voice.stage")}</p>
                <strong>{pendingLiveWatch ? props.t("voice.liveReady", { nickname: pendingLiveWatch.nickname }) : props.t("voice.chooseSource")}</strong>
                <span>{pendingLiveWatch ? props.t("voice.liveReadyCopy") : props.t("voice.chooseSourceCopy")}</span>
              </section>
            )}

            {visualSources.length > 0 ? (
              <section className="visual-source-rail" aria-labelledby="sourceRailTitle">
                <header className="compact-section-head">
                  <div><p className="label" id="sourceRailTitle">{props.t("voice.sources")}</p><span>{props.t("voice.sourcesCopy")}</span></div>
                  <span className="muted small">{visualSources.length}</span>
                </header>
                <ul className="visual-source-list">
                  {visualSources.map((source) => {
                    const selected = selectedKeys.has(source.key);
                    return (
                      <li className={`visual-source ${selected ? "is-selected" : ""}`} key={source.key}>
                        <button className="visual-source-main" type="button" disabled={props.socketState !== "live"} onClick={() => watchSource(source)} aria-pressed={selected}>
                          <span className="source-thumb" aria-hidden="true">
                            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span>{source.connectionStatus === "failed" ? props.t("voice.retry") : props.t("voice.connecting")}</span>}
                          </span>
                          <span className="source-copy"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? props.t("status.screenSharing") : props.t("status.cameraOn")}</span></span>
                        </button>
                        <button
                          className={`icon-btn source-multi-toggle ${selected ? "is-active" : ""}`}
                          type="button"
                          disabled={props.socketState !== "live"}
                          onClick={() => toggleSource(source)}
                          aria-label={selected ? props.t("voice.removeFromStage", { nickname: source.ownerName }) : props.t("voice.addToStage", { nickname: source.ownerName })}
                          aria-pressed={selected}
                        >
                          <EyeIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            <section className="voice-participants" aria-labelledby="participantTitle">
              <header className="compact-section-head"><div><p className="label" id="participantTitle">{props.t("common.members")}</p><span>{props.t("room.pushToMute", { count: connectedCount })}</span></div></header>
              <ul className="participant-list">
                {participants.map((participant) => {
                  const media = mediaFor(participant.userId);
                  const moderation = moderationByUser.get(participant.userId);
                  const audioStream = participant.userId === props.user.id ? null : streamByKey.get(remoteStreamKey(participant.userId, "audio"));
                  const isSpeaking = Boolean(media?.speaking && media.mic && !media.deafened && !moderation?.muted);
                  return (
                    <li className={`participant-row ${isSpeaking ? "is-speaking" : ""}`} key={participant.userId}>
                      <span className="call-avatar" aria-hidden="true">{initial(participant.nickname)}</span>
                      <span className="participant-copy"><strong>{participant.nickname}</strong><VoiceStatusBadges media={media} moderation={moderation} t={props.t} /></span>
                      {audioStream ? (
                        <details className="volume-popover">
                          <summary aria-label={props.t("voice.memberVolume", { nickname: participant.nickname })}><VolumeIcon /></summary>
                          <VolumeControl
                            label={props.t("voice.memberVolume", { nickname: participant.nickname })}
                            value={props.memberVolumes[participant.userId] ?? DEFAULT_VOLUME_PERCENT}
                            onChange={(volume) => props.onMemberVolumeChange(participant.userId, volume)}
                          />
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            {stageStatus ? <p className="voice-stage-status" aria-live="polite">{stageStatus}</p> : null}
          </section>
        ) : (
          <section className="call-surface">
            <EmptyState title={props.t("room.noActiveVoice")} copy={props.t("room.noActiveVoiceCopy")} />
          </section>
        )}
      </main>
    </AppChrome>
  );
}

function OwnerPanel(props: ShellProps) {
  const [users, setUsers] = useState<ServerMember[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [expiry, setExpiry] = useState<InviteExpiryMinutes>(1440);
  const [maxUses, setMaxUses] = useState<InviteMaxUses>(1);
  const [inviteLabel, setInviteLabel] = useState("");
  const [newInvite, setNewInvite] = useState<{ id: string; token: string; label: string } | null>(null);
  const [accessLink, setAccessLink] = useState<{ nickname: string; token: string; expiresAt: string } | null>(null);
  const [status, setStatus] = useState("");
  const [deletingServer, setDeletingServer] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ title: string; copy: string; confirmLabel: string; perform: () => Promise<void> } | null>(null);
  const [nicknameTarget, setNicknameTarget] = useState<PresenceUser | null>(null);
  const reloadRequestRef = useRef(0);
  const newInviteUrl = newInvite ? buildInviteUrl(newInvite.token, resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)) : "";
  const accessLinkUrl = accessLink
    ? `${resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)}/access/claim#token=${accessLink.token}`
    : "";
  const activeServer = props.servers.find((server) => server.id === props.activeServerId);
  const ownerTextRoom = resolveServerTextRoom(
    [...props.rooms.text, ...props.rooms.voice],
    props.activeServerId,
    props.roomHistory[props.activeServerId]?.text
  );
  const ownerChatPath = ownerTextRoom
    ? serverPath(props.activeServerId, "text", ownerTextRoom.id)
    : `/app/server/${encodeURIComponent(props.activeServerId)}/owner`;

  const reload = useCallback(async () => {
    const requestId = ++reloadRequestRef.current;
    try {
      const data = await fetchServerOwnerData(props.activeServerId);
      if (requestId !== reloadRequestRef.current) return;
      setUsers(data.users);
      setInvites(data.invites);
    } catch {
      if (requestId === reloadRequestRef.current) setStatus(props.t("owner.dataError"));
    }
  }, [props.activeServerId, props.t]);

  useEffect(() => {
    setNewInvite(null);
    setAccessLink(null);
    setStatus("");
    void reload();
    return () => {
      reloadRequestRef.current += 1;
    };
  }, [reload]);

  async function createNewInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = inviteLabel.trim();
    if (!label) {
      setStatus(props.t("owner.inviteLabelRequired"));
      return;
    }
    const response = await createServerInvite(props.activeServerId, label, expiry, maxUses);
    setNewInvite({ id: response.invite.id, token: response.invite.token, label: response.invite.label });
    setInviteLabel("");
    setStatus(props.t("owner.created"));
    await reload();
  }

  return (
    <div className="owner-shell">
      <aside className="owner-nav">
        <BrandLockup subtitle={props.t("owner.panel")} href={ownerChatPath} onNavigate={props.onNavigate} />
        <section className="rail-section">
          <a className="channel-item is-active" href="#invites"><span>{props.t("owner.invites")}</span><span /></a>
          <a className="channel-item" href="#users"><span>{props.t("common.users")}</span><span /></a>
        </section>
        <section className="session-card">
          <span className="label">{props.t("owner.access")}</span>
          <MemberRow user={props.currentNickname} detail={props.t("owner.sessionDetail")} owner />
          <p className="muted small">{props.t("owner.normalViewCopy")}</p>
        </section>
      </aside>
      <main className="owner-main" id="main-content">
        <header className="owner-hero">
          <div>
            <p className="label">{activeServer?.name ?? "Voxly"}</p>
            <h1>{props.t("owner.title")}</h1>
            <p className="muted">{props.t("owner.heroCopy")}</p>
          </div>
          <NavLink className="btn" href={ownerChatPath} onNavigate={props.onNavigate}>
            <ChatIcon />
            <span>{props.t("common.backToChat")}</span>
          </NavLink>
        </header>
        <OwnerServerContext
          activeServerId={props.activeServerId}
          servers={props.servers}
          t={props.t}
          onSelect={(serverId) => props.onNavigate(`/app/server/${encodeURIComponent(serverId)}/owner`)}
          onCreate={props.onCreateServer}
          onRename={props.onUpdateServerName}
          onRequestDelete={() => setDeletingServer(true)}
        />
        <section className="owner-grid" id="invites">
          <form className="owner-card" onSubmit={createNewInvite}>
            <div>
              <h2>{props.t("owner.createInviteFor", { server: activeServer?.name ?? "Voxly" })}</h2>
              <p className="muted small">{props.t("owner.createCopy")}</p>
            </div>
            <label className="form-field" htmlFor="inviteLabel">
              <span>{props.t("owner.inviteLabel")}</span>
              <input className="input" id="inviteLabel" name="inviteLabel" value={inviteLabel} onChange={(event) => setInviteLabel(event.target.value)} placeholder={props.t("owner.inviteLabelPlaceholder")} maxLength={80} />
            </label>
            <label className="form-field" htmlFor="expiry">
              <span>{props.t("owner.expiresAfter")}</span>
              <select className="input" id="expiry" name="expiry" value={expiry ?? "never"} onChange={(event) => setExpiry(event.target.value === "never" ? null : Number(event.target.value) as InviteExpiryMinutes)}>
                <option value="30">{props.t("invite.expiry30m")}</option>
                <option value="60">{props.t("invite.expiry1h")}</option>
                <option value="360">{props.t("invite.expiry6h")}</option>
                <option value="720">{props.t("invite.expiry12h")}</option>
                <option value="1440">{props.t("invite.expiry1d")}</option>
                <option value="10080">{props.t("invite.expiry7d")}</option>
                <option value="43200">{props.t("invite.expiry30d")}</option>
                <option value="never">{props.t("common.noExpiry")}</option>
              </select>
            </label>
            <label className="form-field" htmlFor="maxUses">
              <span>{props.t("owner.maxUses")}</span>
              <select className="input" id="maxUses" name="maxUses" value={maxUses ?? "unlimited"} onChange={(event) => setMaxUses(event.target.value === "unlimited" ? null : Number(event.target.value) as InviteMaxUses)}>
                {[1, 5, 10, 25, 50, 100].map((count) => <option key={count} value={count}>{props.t("invite.useCount", { count })}</option>)}
                <option value="unlimited">{props.t("invite.unlimitedUses")}</option>
              </select>
            </label>
            <button className="btn btn-primary" type="submit">
              <PlusIcon />
              <span>{props.t("common.createInvite")}</span>
            </button>
            {newInviteUrl ? (
              <div className="invite-status is-valid">
                <strong>{props.t("owner.newInviteLink")}</strong>
                <span>{newInvite?.label}</span>
                <SecretLinkDisplay key={newInviteUrl} value={newInviteUrl} t={props.t} />
                <span className="muted small">{props.t("owner.newInviteLinkCopy")}</span>
                <button className="btn btn-ghost" type="button" onClick={async () => {
                  try {
                    await navigator.clipboard?.writeText(newInviteUrl);
                    setStatus(props.t("owner.copied"));
                  } catch {
                    setStatus(props.t("owner.copyFailed"));
                  }
                }}>
                  <CopyIcon />
                  <span>{props.t("common.copy")}</span>
                </button>
              </div>
            ) : null}
          </form>
          <section className="table-card">
            <div className="table-head"><span>{props.t("owner.reference")}</span><span>{props.t("owner.uses")}</span><span>{props.t("common.expiry")}</span><span>{props.t("common.actions")}</span></div>
            {invites.map((invite) => (
              <div className="table-row" key={invite.id}>
                <span><strong>{invite.label || props.t("owner.unlabeledInvite")}</strong><br /><span className="mono muted small">{inviteReference(invite.id)}</span></span>
                <span>{invite.maxUses === null
                  ? props.t("invite.usedUnlimited", { used: invite.usedCount })
                  : `${props.t("invite.usedOfLimit", { used: invite.usedCount, limit: invite.maxUses })} · ${props.t("invite.remainingUses", { count: Math.max(0, invite.maxUses - invite.usedCount) })}`}
                  <br /><span className="muted small">{props.t(inviteLifecycleKey(invite))}</span>
                </span>
                <span>{formatShortDate(invite.expiresAt, props.language, props.t)}</span>
                <span>
                  <button className="btn btn-danger" type="button" disabled={!isInviteRevocable(invite)} onClick={() => setPendingAction({
                    title: "Revoke invite?",
                    copy: props.t("owner.revokeConfirm"),
                    confirmLabel: props.t("common.revoke"),
                    perform: async () => {
                      setStatus("");
                      await revokeServerInvite(props.activeServerId, invite.id);
                      await reload();
                    }
                  })}>
                    <TrashIcon />
                    <span>{props.t("common.revoke")}</span>
                  </button>
                </span>
              </div>
            ))}
          </section>
        </section>
        <section className="owner-grid members-grid" id="users">
          <section className="table-card">
            <div className="table-head"><span>{props.t("common.user")}</span><span>{props.t("common.role")}</span><span>{props.t("common.status")}</span><span>{props.t("common.actions")}</span></div>
            {users.map((item) => (
              <div className="table-row" key={item.id}>
                <span><MemberRow user={item.nickname} detail={item.role === "owner" ? props.t("shell.ownerSession") : props.t("shell.memberSession")} owner={item.role === "owner"} /></span>
                <span>{item.role === "owner" ? props.t("common.owner") : props.t("common.user")}</span>
                <span><StatusPill tone={item.bannedAt ? "danger" : "online"}>{item.bannedAt ? props.t("common.banned") : props.t("common.active")}</StatusPill></span>
                <span className="table-actions">
                  {(item.role !== "owner" || item.id === props.user.id) ? <button className="btn btn-ghost" type="button" onClick={() => setNicknameTarget({
                    userId: item.id,
                    nickname: item.nickname,
                    role: item.role
                  })}><EditIcon /><span>{props.t("member.changeNickname")}</span></button> : null}
                  {item.role !== "owner" ? <>
                    <button className={`btn ${item.moderation.muted ? "btn-danger moderation-toggle is-enforced" : "btn-ghost moderation-toggle"}`} type="button" aria-pressed={item.moderation.muted} onClick={async () => {
                      const response = await props.onVoiceModeration(item.id, { muted: !item.moderation.muted });
                      setUsers((current) => current.map((member) => member.id === item.id ? { ...member, moderation: response.moderation } : member));
                    }}><MicIcon off={item.moderation.muted} /><span>{item.moderation.muted ? props.t("member.ownerUnmute") : props.t("member.ownerMute")}</span></button>
                    <button className={`btn ${item.moderation.deafened ? "btn-danger moderation-toggle is-enforced" : "btn-ghost moderation-toggle"}`} type="button" aria-pressed={item.moderation.deafened} onClick={async () => {
                      const response = await props.onVoiceModeration(item.id, { deafened: !item.moderation.deafened });
                      setUsers((current) => current.map((member) => member.id === item.id ? { ...member, moderation: response.moderation } : member));
                    }}><HeadsetIcon off={item.moderation.deafened} /><span>{item.moderation.deafened ? props.t("member.ownerUndeafen") : props.t("member.ownerDeafen")}</span></button>
                    <button className="btn btn-ghost" type="button" onClick={async () => {
                      try {
                        const response = await createAccessLink(props.activeServerId, item.id);
                        setAccessLink({ nickname: item.nickname, token: response.token, expiresAt: response.expiresAt });
                      } catch {
                        setStatus("Access link could not be created.");
                      }
                    }}><CopyIcon /><span>Access link</span></button>
                    <button className="btn btn-danger" type="button" onClick={() => {
                      const action = item.bannedAt ? "unban" : "ban";
                      setPendingAction({
                        title: action === "ban" ? `Ban ${item.nickname}?` : `Unban ${item.nickname}?`,
                        copy: action === "ban" ? props.t("owner.banConfirm", { nickname: item.nickname }) : "This restores the member's access to this server.",
                        confirmLabel: action === "ban" ? props.t("common.ban") : "Unban",
                        perform: async () => {
                          await props.onModerateMember(item.id, action);
                          await reload();
                        }
                      });
                    }}>
                      <ShieldIcon />
                      <span>{item.bannedAt ? "Unban" : props.t("common.ban")}</span>
                    </button>
                    {!item.bannedAt ? <button className="btn btn-danger" type="button" onClick={() => setPendingAction({
                      title: `Kick ${item.nickname}?`,
                      copy: "The member can return only with a new invite.",
                      confirmLabel: "Kick",
                      perform: async () => {
                        await props.onModerateMember(item.id, "kick");
                        await reload();
                      }
                    })}><LeaveIcon /><span>Kick</span></button> : null}
                  </> : null}
                </span>
              </div>
            ))}
          </section>
          <section className="owner-card">
            <h2>{props.t("owner.policyTitle")}</h2>
            <p className="muted">{props.t("owner.policyCopy")}</p>
            <div className="invite-status is-valid"><strong>{props.t("owner.normalView")}</strong><span className="muted small">{props.t("owner.normalViewCopy")}</span></div>
          </section>
        </section>
        {accessLink ? (
          <section className="owner-card access-link-card" aria-live="polite">
            <h2>Access link for {accessLink.nickname}</h2>
            <SecretLinkDisplay key={accessLinkUrl} value={accessLinkUrl} t={props.t} />
            <p className="muted small">Expires {formatShortDate(accessLink.expiresAt, props.language, props.t)}. It can be used once.</p>
            <button className="btn btn-ghost" type="button" onClick={() => void navigator.clipboard?.writeText(accessLinkUrl)}><CopyIcon /><span>{props.t("common.copy")}</span></button>
          </section>
        ) : null}
        <p className="error-text" aria-live="polite">{status}</p>
        {pendingAction ? <ConfirmDialog
          title={pendingAction.title}
          copy={pendingAction.copy}
          confirmLabel={pendingAction.confirmLabel}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            setPendingAction(null);
            void action.perform().catch(() => setStatus("This action could not be completed."));
          }}
        /> : null}
        {deletingServer && activeServer ? <ConfirmDialog
          title={props.t("server.deleteTitle", { server: activeServer.name })}
          copy={props.t("server.deleteCopy")}
          confirmLabel={props.t("common.delete")}
          confirmationText={activeServer.name}
          confirmationLabel={props.t("common.typeToConfirm")}
          onCancel={() => setDeletingServer(false)}
          onConfirm={() => {
            setDeletingServer(false);
            setStatus("");
            void props.onDeleteServer().catch((error: unknown) => {
              if (error instanceof ApiError && error.code === "last_owner_server") {
                setStatus(props.t("server.lastServer"));
                return;
              }
              setStatus(props.t("common.deleteFailed"));
            });
          }}
        /> : null}
        {nicknameTarget ? <NicknameDialog
          user={nicknameTarget}
          t={props.t}
          onCancel={() => setNicknameTarget(null)}
          onSave={async (nickname) => {
            await props.onUpdateMemberNickname(nicknameTarget.userId, nickname);
            setNicknameTarget(null);
            setStatus(props.t("member.nicknameUpdated"));
            await reload();
          }}
        /> : null}
      </main>
    </div>
  );
}

function SecretLinkDisplay({ value, t }: { value: string; t: Translate }) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? t("owner.hideLink") : t("owner.revealLink");
  return (
    <div className="secret-link-display">
      <span className="mono">{revealed ? value : maskSecretLink(value)}</span>
      <button className="secret-link-toggle" type="button" aria-label={label} title={label} aria-pressed={revealed} onClick={() => setRevealed((current) => !current)}>
        <EyeIcon off={revealed} />
      </button>
    </div>
  );
}

function OwnerServerContext({
  activeServerId,
  servers,
  t,
  onSelect,
  onCreate,
  onRename,
  onRequestDelete
}: {
  activeServerId: string;
  servers: ServerSummary[];
  t: Translate;
  onSelect: (serverId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (name: string) => Promise<ServerSummary>;
  onRequestDelete: () => void;
}) {
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const [renameName, setRenameName] = useState("");
  const [renameStatus, setRenameStatus] = useState("");
  const [isRenaming, setIsRenaming] = useState(false);
  const ownerServers = servers.filter((server) => server.role === "owner");
  const activeServer = ownerServers.find((server) => server.id === activeServerId);

  useEffect(() => {
    setRenameName(activeServer?.name ?? "");
    setRenameStatus("");
  }, [activeServer?.id, activeServer?.name]);

  return (
    <section className="owner-server-context" aria-labelledby="ownerServerContextTitle">
      <div className="owner-server-context-copy">
        <p className="label">{t("owner.serverContextLabel")}</p>
        <h2 id="ownerServerContextTitle">{t("owner.serverContextTitle")}</h2>
        <p className="muted small">{t("owner.serverContextCopy")}</p>
      </div>
      <label className="form-field owner-server-select" htmlFor="ownerServerSelect">
        <span>{t("owner.targetServer")}</span>
        <select className="input" id="ownerServerSelect" value={activeServerId} onChange={(event) => onSelect(event.currentTarget.value)}>
          {ownerServers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}
        </select>
      </label>
      <div className="owner-server-actions">
        <button className="btn btn-primary" type="button" aria-expanded={showCreate} aria-controls="owner-server-create-form" onClick={() => {
          setShowCreate((current) => !current);
          setError("");
        }}><PlusIcon /><span>{t("server.create")}</span></button>
        <button className="btn btn-danger" type="button" disabled={ownerServers.length <= 1} onClick={onRequestDelete}><TrashIcon /><span>{t("server.delete")}</span></button>
      </div>
      <form className="owner-server-rename-form" onSubmit={(event) => {
        event.preventDefault();
        const nextName = renameName.trim();
        if (nextName.length < 2 || nextName.length > 64) {
          setRenameStatus(t("server.nameLength"));
          return;
        }
        setIsRenaming(true);
        setRenameStatus("");
        void onRename(nextName)
          .then(() => setRenameStatus(t("server.renamed")))
          .catch(() => setRenameStatus(t("server.renameFailed")))
          .finally(() => setIsRenaming(false));
      }}>
        <label className="form-field owner-server-rename-field" htmlFor="ownerServerRename">
          <span>{t("server.rename")}</span>
          <input
            className="input"
            id="ownerServerRename"
            name="ownerServerRename"
            value={renameName}
            minLength={2}
            maxLength={64}
            autoComplete="off"
            onChange={(event) => setRenameName(event.currentTarget.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={isRenaming || renameName.trim() === activeServer?.name}>
          <EditIcon />
          <span>{t("common.save")}</span>
        </button>
        <p className="muted small owner-server-rename-copy">{t("server.renameCopy")}</p>
        <p className="small owner-server-rename-status" aria-live="polite">{renameStatus}</p>
      </form>
      {showCreate ? <form className="owner-server-create-form" id="owner-server-create-form" onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();
        if (!nextName) {
          setError(t("server.nameRequired"));
          return;
        }
        setIsCreating(true);
        setError("");
        void onCreate(nextName)
          .then(() => {
            setName("");
            setShowCreate(false);
          })
          .catch(() => setError(t("server.createFailed")))
          .finally(() => setIsCreating(false));
      }}>
        <label className="form-field" htmlFor="ownerServerName"><span>{t("server.name")}</span><input className="input" id="ownerServerName" name="ownerServerName" value={name} onChange={(event) => setName(event.currentTarget.value)} autoComplete="off" maxLength={64} /></label>
        <button className="btn btn-primary" type="submit" disabled={isCreating}><span>{isCreating ? t("server.creating") : t("server.create")}</span></button>
        {error ? <p className="error-text" aria-live="polite">{error}</p> : null}
      </form> : null}
    </section>
  );
}

interface SidebarActionMenuController {
  active: ContextMenuDescriptor | null;
  close: () => void;
  open: (input: {
    key: string;
    x: number;
    y: number;
    menuWidth: number;
    menuHeight: number;
    trigger: HTMLButtonElement | null;
  }) => void;
}

function SidebarMenuTrigger({
  actionMenu,
  menuKey,
  label,
  menuWidth,
  menuHeight
}: {
  actionMenu: SidebarActionMenuController;
  menuKey: string;
  label: string;
  menuWidth: number;
  menuHeight: number;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      ref={triggerRef}
      className="sidebar-menu-trigger"
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={actionMenu.active?.key === menuKey}
      onClick={() => {
        const rect = triggerRef.current?.getBoundingClientRect();
        if (!rect) return;
        actionMenu.open({
          key: menuKey,
          x: rect.right - menuWidth,
          y: rect.bottom + 4,
          menuWidth,
          menuHeight,
          trigger: triggerRef.current
        });
      }}
    >
      <MoreIcon />
    </button>
  );
}

function openSidebarMenuFromPointer(
  event: MouseEvent<HTMLElement>,
  actionMenu: SidebarActionMenuController,
  key: string,
  menuWidth: number,
  menuHeight: number
) {
  event.preventDefault();
  actionMenu.open({
    key,
    x: event.clientX,
    y: event.clientY,
    menuWidth,
    menuHeight,
    trigger: null
  });
}

function AppChrome(props: ShellProps & { children: ReactNode; mobileTitle: string }) {
  const canModerate = activeServerRole(props) === "owner";
  const [nicknameTarget, setNicknameTarget] = useState<{ user: PresenceUser; returnFocus: HTMLButtonElement | null } | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<{ user: PresenceUser; roomId?: string; action: MemberAction } | null>(null);
  const [activeActionMenu, dispatchActionMenu] = useReducer(contextMenuReducer, null);
  const closeActionMenu = useCallback(() => dispatchActionMenu({ type: "close" }), []);
  const openActionMenu = useCallback((input: Parameters<SidebarActionMenuController["open"]>[0]) => {
    dispatchActionMenu({
      type: "open",
      menu: createContextMenuDescriptor({
        ...input,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    });
  }, []);
  const actionMenu = useMemo<SidebarActionMenuController>(() => ({
    active: activeActionMenu,
    close: closeActionMenu,
    open: openActionMenu
  }), [activeActionMenu, closeActionMenu, openActionMenu]);
  const onlineCount = props.onlineUsers.length || 1;
  const voiceConnectedCount = props.activeVoiceRoomId && props.voiceSnapshots[props.activeVoiceRoomId]
    ? props.voiceSnapshots[props.activeVoiceRoomId].members.length
    : props.activeVoiceRoomId
      ? 1
      : 0;

  useEffect(() => {
    closeActionMenu();
  }, [closeActionMenu, props.activeServerId, props.currentRoom?.id, props.drawer, props.route.name]);

  return (
    <>
      <a className="skip-link" href="#main-content">{props.t("shell.skip")}</a>
      <div className={`drawer-scrim ${props.drawer ? "is-visible" : ""}`} onClick={() => props.onDrawerChange(null)} />
      <div className="mobile-topbar">
        <button className="icon-btn" type="button" onClick={() => props.onDrawerChange(props.drawer === "channels" ? null : "channels")} aria-label={props.t("common.rooms")}>
          <MenuIcon />
          <span>{props.t("common.rooms")}</span>
        </button>
        <BrandLockup title={props.mobileTitle} subtitle={props.t("common.connected", { count: onlineCount })} href={serverPath(props.activeServerId, "text", props.rooms.text[0]?.id ?? "general")} onNavigate={props.onNavigate} />
        <button className="icon-btn" type="button" onClick={() => props.onDrawerChange(props.drawer === "members" ? null : "members")} aria-label={props.t("common.users")}>
          <UsersIcon />
          <span>{props.t("common.users")}</span>
        </button>
      </div>
      <div className={`app-shell drawer-${props.drawer ?? "none"}`}>
        <ChannelRail
          {...props}
          actionMenu={actionMenu}
          onRequestNickname={(member, returnFocus) => setNicknameTarget({ user: member, returnFocus })}
          onRequestMemberAction={(member, action, roomId) => {
            closeActionMenu();
            setPendingMemberAction({ user: member, action, roomId });
          }}
        />
        {props.children}
        <MemberPanel
          members={props.serverMembers}
          onlineUsers={props.onlineUsers}
          voiceRooms={props.rooms.voice}
          voiceSnapshots={props.voiceSnapshots}
          currentUser={props.user}
          canModerate={canModerate}
          memberVolumes={props.memberVolumes}
          onMemberVolumeChange={props.onMemberVolumeChange}
          onVoiceModeration={props.onVoiceModeration}
          onRequestNickname={(member, returnFocus) => setNicknameTarget({ user: member, returnFocus })}
          onRequestMemberAction={(member, action, roomId) => {
            closeActionMenu();
            setPendingMemberAction({ user: member, action, roomId });
          }}
          actionMenu={actionMenu}
          t={props.t}
        />
      </div>
      <VoiceDock {...props} connectedCount={voiceConnectedCount} />
      <Toast message={props.voiceError} />
      {nicknameTarget ? <NicknameDialog
        user={nicknameTarget.user}
        returnFocus={nicknameTarget.returnFocus}
        t={props.t}
        onCancel={() => setNicknameTarget(null)}
        onSave={async (nickname) => {
          await props.onUpdateMemberNickname(nicknameTarget.user.userId, nickname);
          setNicknameTarget(null);
        }}
      /> : null}
      {pendingMemberAction ? <ConfirmDialog
        title={props.t(`member.${pendingMemberAction.action}Title` as TranslationKey, { nickname: pendingMemberAction.user.nickname })}
        copy={props.t(`member.${pendingMemberAction.action}Copy` as TranslationKey)}
        confirmLabel={props.t(`member.${pendingMemberAction.action}` as TranslationKey)}
        onCancel={() => setPendingMemberAction(null)}
        onConfirm={() => {
          const pending = pendingMemberAction;
          setPendingMemberAction(null);
          if (pending.action === "disconnect" && pending.roomId) {
            void props.onDisconnectMember(pending.roomId, pending.user.userId);
          } else if (pending.action === "kick" || pending.action === "ban") {
            void props.onModerateMember(pending.user.userId, pending.action);
          }
        }}
      /> : null}
    </>
  );
}

function ChannelRail(props: ShellProps & {
  actionMenu: SidebarActionMenuController;
  onRequestNickname: (user: PresenceUser, returnFocus: HTMLButtonElement | null) => void;
  onRequestMemberAction: (user: PresenceUser, action: MemberAction, roomId?: string) => void;
}) {
  const canManageServer = activeServerRole(props) === "owner";
  const [deleteTarget, setDeleteTarget] = useState<RoomSummary | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [moveTarget, setMoveTarget] = useState<RoomSummary | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const activateVoiceRoom = (room: RoomSummary) => {
    if (props.socketState !== "live") return;
    const action = voiceChannelActivation(props.activeVoiceRoomId, room.id);
    if (action === "open") {
      props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
      return;
    }
    if (action === "confirm-move") {
      setMoveTarget(room);
      return;
    }
    setJoiningRoomId(room.id);
    void props.onJoinVoice(room.id)
      .then((joined) => {
        if (joined) props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
      })
      .finally(() => setJoiningRoomId(null));
  };
  return (
    <aside className="rail">
      <BrandLockup subtitle="" href={serverPath(props.activeServerId, "text", props.rooms.text[0]?.id ?? "general")} onNavigate={props.onNavigate} />
      <ServerSwitcher
        activeServerId={props.activeServerId}
        servers={props.servers}
        labels={{
          switcher: props.t("server.switcher"),
          server: props.t("server.label")
        }}
        onSelect={props.onSelectServer}
      />
      <section className="rail-section">
        <div className="rail-section-head"><span className="label">{props.t("room.textRooms")}</span>{canManageServer ? <ChannelCreateControl kind="text" onCreate={props.onCreateRoom} /> : null}</div>
        {props.rooms.text.map((room) => (
          <div
            className="channel-row"
            key={room.id}
            onContextMenu={canManageServer ? (event) => openSidebarMenuFromPointer(event, props.actionMenu, `channel:${room.id}`, 176, 48) : undefined}
          >
            <NavLink className={`channel-item ${props.route.name === "text" && props.route.roomId === room.id ? "is-active" : ""}`} href={serverPath(props.activeServerId, "text", room.id)} onNavigate={props.onNavigate}>
              <span className="channel-prefix">#</span><span>{room.name}</span>{props.unreadByRoom[room.id] ? <span className="badge unread-badge">{props.unreadByRoom[room.id]}</span> : <span />}
            </NavLink>
            {canManageServer ? <ChannelDeleteControl actionMenu={props.actionMenu} room={room} disabled={props.rooms.text.length + props.rooms.voice.length <= 1} onRequest={() => setDeleteTarget(room)} t={props.t} /> : null}
          </div>
        ))}
      </section>
      <section className="rail-section">
        <div className="rail-section-head"><span className="label">{props.t("room.voiceRooms")}</span>{canManageServer ? <ChannelCreateControl kind="voice" onCreate={props.onCreateRoom} /> : null}</div>
        {props.rooms.voice.map((room) => {
          const members = voiceMembersForRoom(props, room.id);
          return (
            <div className="voice-channel-block" key={room.id}>
              <div
                className="channel-row"
                onContextMenu={canManageServer ? (event) => openSidebarMenuFromPointer(event, props.actionMenu, `channel:${room.id}`, 176, 48) : undefined}
              >
                <NavLink
                  className={`channel-item ${props.route.name === "voice" && props.route.roomId === room.id ? "is-active" : ""}`}
                  href={serverPath(props.activeServerId, "voice", room.id)}
                  onNavigate={props.onNavigate}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                    event.preventDefault();
                    if (joiningRoomId) return;
                    activateVoiceRoom(room);
                  }}
                >
                  <span className="channel-prefix" aria-hidden="true"><MicIcon off={false} /></span><span>{room.name}</span>
                </NavLink>
                {canManageServer ? <ChannelDeleteControl actionMenu={props.actionMenu} room={room} disabled={props.rooms.text.length + props.rooms.voice.length <= 1} onRequest={() => setDeleteTarget(room)} t={props.t} /> : null}
              </div>
              {members.length > 0 ? (
                <div className="voice-channel-users">
                  {members.map((member) => {
                    const isRemote = member.user.userId !== props.user.id;
                    const canRename = canManageServer && (member.user.role === "member" || member.user.userId === props.user.id);
                    const canModerate = canManageServer && isRemote;
                    const menuHeight = memberActionMenuHeight({
                      hasVolume: isRemote,
                      canRename,
                      canDisconnect: canModerate,
                      canModerate,
                      canVoiceModerate: canModerate
                    });
                    const hasActions = isRemote || canRename || canModerate;
                    const menuKey = `rail-member:${member.user.userId}`;
                    return (
                    <div
                      className={`voice-channel-user ${member.media.speaking && member.media.mic && !member.media.deafened && !member.moderation.muted ? "is-speaking" : ""}`}
                      key={member.user.userId}
                      tabIndex={hasActions ? 0 : undefined}
                      onContextMenu={hasActions
                        ? (event) => openSidebarMenuFromPointer(event, props.actionMenu, menuKey, 220, menuHeight)
                        : undefined}
                      onKeyDown={hasActions ? (event) => {
                        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        props.actionMenu.open({
                          key: menuKey,
                          x: rect.right - 220,
                          y: rect.bottom + 4,
                          menuWidth: 220,
                          menuHeight,
                          trigger: null
                        });
                      } : undefined}
                    >
                      <span className="avatar">{initial(member.user.nickname)}</span>
                      <span className="voice-channel-user-copy">
                        <span className="voice-channel-user-name">
                          {member.media.screen ? (
                            <LiveStreamPopover
                              icon={<ScreenIcon off={false} />}
                              liveLabel={props.t("common.live")}
                              nickname={member.user.nickname}
                              watchLabel={props.t("voice.watchStream")}
                              watchAriaLabel={props.t("voice.watchUserStream", { nickname: member.user.nickname })}
                              onWatch={() => props.onWatchLive({
                                serverId: props.activeServerId,
                                roomId: room.id,
                                publisherUserId: member.user.userId,
                                nickname: member.user.nickname
                              })}
                            />
                          ) : <span>{member.user.nickname}</span>}
                        </span>
                      </span>
                      <span className="voice-channel-statuses">
                        {member.moderation.deafened ? <span className="voice-channel-status is-enforced" aria-label={props.t("member.ownerDeafened")}><HeadsetIcon off /></span> : null}
                        {member.moderation.muted ? <span className="voice-channel-status is-enforced" aria-label={props.t("member.ownerMuted")}><MicIcon off /></span> : null}
                        {sidebarVoiceStatusKeys(member.media).map((status) => (
                          <span className={`voice-channel-status is-${status} is-self`} aria-label={props.t(`common.${status}` as TranslationKey)} key={status}>
                            {status === "deafened" ? <HeadsetIcon off /> : <MicIcon off />}
                          </span>
                        ))}
                      </span>
                      {hasActions ? (
                        <MemberActionMenu
                          actionMenu={props.actionMenu}
                          menuKey={menuKey}
                          member={member.user}
                          volume={isRemote ? props.memberVolumes[member.user.userId] ?? DEFAULT_VOLUME_PERCENT : undefined}
                          onVolumeChange={isRemote ? (volume) => props.onMemberVolumeChange(member.user.userId, volume) : undefined}
                          canRename={canRename}
                          canDisconnect={canModerate}
                          canModerate={canModerate}
                          moderation={canModerate ? member.moderation : undefined}
                          onVoiceModeration={canModerate ? (moderation) => { void props.onVoiceModeration(member.user.userId, moderation); } : undefined}
                          onRename={(returnFocus) => props.onRequestNickname(member.user, returnFocus)}
                          onRequestAction={(action) => props.onRequestMemberAction(member.user, action, room.id)}
                          showTrigger={false}
                          t={props.t}
                        />
                      ) : null}
                    </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
      <PreferencesCard
        language={props.language}
        theme={props.theme}
        t={props.t}
        onLanguageChange={props.onLanguageChange}
        onThemeChange={props.onThemeChange}
      />
      <AudioDeviceSettings
        inputs={props.audioDevices.inputs}
        outputs={props.audioDevices.outputs}
        selectedInputId={props.audioDevices.selectedInputId}
        selectedOutputId={props.audioDevices.selectedOutputId}
        inputVolume={props.audioLevels.input}
        outputVolume={props.audioLevels.output}
        microphoneTestActive={props.microphoneTestActive}
        microphoneTestError={props.microphoneTestError}
        loading={props.audioDevices.loading}
        error={props.audioDevices.error}
        unavailableSelections={props.audioDevices.unavailableSelections}
        outputSelectionSupported={props.audioDevices.outputSelectionSupported}
        labels={{
          title: props.t("audio.title"),
          microphone: props.t("audio.microphone"),
          output: props.t("audio.output"),
          systemDefault: props.t("audio.systemDefault"),
          browserControlled: props.t("audio.browserControlled"),
          refresh: props.t("audio.refresh"),
          unavailable: props.t("audio.unavailable"),
          inputVolume: props.t("audio.inputVolume"),
          outputVolume: props.t("audio.outputVolume"),
          startTest: props.t("audio.startTest"),
          stopTest: props.t("audio.stopTest"),
          testHint: props.t("audio.testHint"),
          testPermission: props.t("audio.testPermission"),
          testUnavailable: props.t("audio.testUnavailable"),
          closeSettings: props.t("audio.closeSettings")
        }}
        onOpen={() => props.audioDevices.refresh(true)}
        onClose={props.onCloseAudioSettings}
        onRefresh={() => props.audioDevices.refresh(true)}
        onSelectInput={props.audioDevices.selectInput}
        onSelectOutput={props.audioDevices.selectOutput}
        onInputVolumeChange={props.onInputVolumeChange}
        onOutputVolumeChange={props.onOutputVolumeChange}
        onToggleMicrophoneTest={props.onToggleMicrophoneTest}
      />
      {deleteError ? <p className="error-text" aria-live="polite">{deleteError}</p> : null}
      {deleteTarget ? <ConfirmDialog
        title={props.t("room.deleteTitle", { channel: deleteTarget.name })}
        copy={props.t("room.deleteCopy")}
        confirmLabel={props.t("common.delete")}
        confirmationText={deleteTarget.name}
        confirmationLabel={props.t("common.typeToConfirm")}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const room = deleteTarget;
          setDeleteTarget(null);
          setDeleteError("");
          void props.onDeleteRoom(room.id).catch((error: unknown) => {
            if (error instanceof ApiError && error.code === "last_room") {
              setDeleteError(props.t("room.lastRoom"));
            } else {
              setDeleteError(props.t("common.deleteFailed"));
            }
          });
        }}
      /> : null}
      {moveTarget ? <ConfirmDialog
        title={props.t("voice.moveTitle")}
        copy={props.t("voice.moveCopy", {
          current: props.rooms.voice.find((room) => room.id === props.activeVoiceRoomId)?.name ?? props.t("room.lobbyVoice"),
          target: moveTarget.name
        })}
        confirmLabel={props.t("voice.moveConfirm")}
        onCancel={() => setMoveTarget(null)}
        onConfirm={() => {
          const room = moveTarget;
          setMoveTarget(null);
          setJoiningRoomId(room.id);
          void props.onJoinVoice(room.id)
            .then((joined) => {
              if (joined) props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
            })
            .finally(() => setJoiningRoomId(null));
        }}
      /> : null}
    </aside>
  );
}

function ChannelDeleteControl({
  actionMenu,
  room,
  disabled,
  onRequest,
  t
}: {
  actionMenu: SidebarActionMenuController;
  room: RoomSummary;
  disabled: boolean;
  onRequest: () => void;
  t: Translate;
}) {
  const menuKey = `channel:${room.id}`;
  const label = t("room.actionsFor", { channel: room.name });
  return (
    <>
      <SidebarMenuTrigger actionMenu={actionMenu} menuKey={menuKey} label={label} menuWidth={176} menuHeight={48} />
      {actionMenu.active?.key === menuKey ? (
        <ContextMenu descriptor={actionMenu.active} label={label} onClose={actionMenu.close}>
          <button className="is-danger" type="button" disabled={disabled} onClick={() => {
            actionMenu.close();
            onRequest();
          }}>{t("room.deleteChannel")}</button>
        </ContextMenu>
      ) : null}
    </>
  );
}

function memberActionMenuHeight({ hasVolume, canRename, canDisconnect, canModerate, canVoiceModerate = false }: {
  hasVolume: boolean;
  canRename: boolean;
  canDisconnect: boolean;
  canModerate: boolean;
  canVoiceModerate?: boolean;
}) {
  return 20 + (hasVolume ? 64 : 0) + (canRename ? 40 : 0) + (canVoiceModerate ? 80 : 0) + (canDisconnect ? 40 : 0) + (canModerate ? 80 : 0);
}

function MemberActionMenu({
  actionMenu,
  menuKey,
  member,
  volume,
  onVolumeChange,
  canRename,
  canDisconnect,
  canModerate,
  moderation,
  onVoiceModeration,
  onRename,
  onRequestAction,
  showTrigger = true,
  t
}: {
  actionMenu: SidebarActionMenuController;
  menuKey: string;
  member: PresenceUser;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  canRename: boolean;
  canDisconnect: boolean;
  canModerate: boolean;
  moderation?: VoiceModerationState;
  onVoiceModeration?: (moderation: Partial<VoiceModerationState>) => void;
  onRename: (returnFocus: HTMLButtonElement | null) => void;
  onRequestAction: (action: MemberAction) => void;
  showTrigger?: boolean;
  t: Translate;
}) {
  const label = t("member.actionsFor", { nickname: member.nickname });
  const menuHeight = memberActionMenuHeight({
    hasVolume: volume !== undefined && Boolean(onVolumeChange),
    canRename,
    canDisconnect,
    canModerate,
    canVoiceModerate: Boolean(moderation && onVoiceModeration)
  });
  return (
    <>
      {showTrigger ? <SidebarMenuTrigger actionMenu={actionMenu} menuKey={menuKey} label={label} menuWidth={220} menuHeight={menuHeight} /> : null}
      {actionMenu.active?.key === menuKey ? (
        <ContextMenu descriptor={actionMenu.active} label={label} onClose={actionMenu.close}>
          {volume !== undefined && onVolumeChange ? <VolumeControl
            label={t("voice.memberVolume", { nickname: member.nickname })}
            value={volume}
            onChange={onVolumeChange}
          /> : null}
          {canRename ? <button type="button" onClick={() => {
            const returnFocus = actionMenu.active?.trigger ?? null;
            actionMenu.close();
            onRename(returnFocus);
          }}>{t("member.changeNickname")}</button> : null}
          {moderation && onVoiceModeration ? <>
            <button className={moderation.muted ? "is-danger" : ""} type="button" aria-pressed={moderation.muted} onClick={() => onVoiceModeration({ muted: !moderation.muted })}>{moderation.muted ? t("member.ownerUnmute") : t("member.ownerMute")}</button>
            <button className={moderation.deafened ? "is-danger" : ""} type="button" aria-pressed={moderation.deafened} onClick={() => onVoiceModeration({ deafened: !moderation.deafened })}>{moderation.deafened ? t("member.ownerUndeafen") : t("member.ownerDeafen")}</button>
          </> : null}
          {canDisconnect ? <button type="button" onClick={() => onRequestAction("disconnect")}>{t("member.disconnect")}</button> : null}
          {canModerate ? <>
            <button className="is-danger" type="button" onClick={() => onRequestAction("kick")}>{t("member.kick")}</button>
            <button className="is-danger" type="button" onClick={() => onRequestAction("ban")}>{t("member.ban")}</button>
          </> : null}
        </ContextMenu>
      ) : null}
    </>
  );
}

function ChannelCreateControl({ kind, onCreate }: { kind: "text" | "voice"; onCreate: (name: string, kind: "text" | "voice") => Promise<void> }) {
  const [name, setName] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const close = () => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({ top: rect.bottom + 8, left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)) });
    }
    setIsOpen(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [isOpen]);

  return (
    <>
      <button className="channel-create-trigger" ref={triggerRef} type="button" onClick={open} aria-label={`Create ${kind} channel`} aria-expanded={isOpen}><PlusIcon /></button>
      {isOpen ? createPortal(<div className="channel-create-popover" ref={popoverRef} role="dialog" aria-label={`Create ${kind} channel`} style={position}>
        <form onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();
        if (!nextName) return;
        setIsBusy(true);
        void onCreate(nextName, kind).finally(() => {
          setName("");
          setIsBusy(false);
          setIsOpen(false);
        });
      }}>
          <label className="form-field"><span>{kind === "text" ? "Text channel name" : "Voice channel name"}</span><input className="input" ref={inputRef} name={`${kind}ChannelName`} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={64} autoComplete="off" /></label>
          <div className="channel-create-actions"><button className="btn btn-ghost" type="button" onClick={close}>Cancel</button><button className="btn btn-primary" type="submit" disabled={isBusy}>{isBusy ? "Creating…" : "Create"}</button></div>
        </form>
      </div>, document.body) : null}
    </>
  );
}

function MemberPanel({
  members,
  onlineUsers,
  voiceRooms,
  voiceSnapshots,
  currentUser,
  canModerate,
  memberVolumes,
  onMemberVolumeChange,
  onVoiceModeration,
  onRequestNickname,
  onRequestMemberAction,
  actionMenu,
  t
}: {
  members: PresenceUser[];
  onlineUsers: PresenceUser[];
  voiceRooms: RoomSummary[];
  voiceSnapshots: Record<string, VoiceSnapshot>;
  currentUser: PublicUser;
  canModerate: boolean;
  memberVolumes: Record<string, number>;
  onMemberVolumeChange: (userId: string, volume: number) => void;
  onVoiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) => Promise<{ moderation: VoiceModerationState }>;
  onRequestNickname: (user: PresenceUser, returnFocus: HTMLButtonElement | null) => void;
  onRequestMemberAction: (user: PresenceUser, action: MemberAction, roomId?: string) => void;
  actionMenu: SidebarActionMenuController;
  t: Translate;
}) {
  const roomByMemberId = new Map<string, RoomSummary>();
  for (const room of voiceRooms) {
    for (const member of voiceSnapshots[room.id]?.members ?? []) {
      roomByMemberId.set(member.user.userId, room);
    }
  }
  const groupedMembers = groupDirectoryMembers(members, onlineUsers, presenceFromUser(currentUser));
  const renderMembers = (users: PresenceUser[], online: boolean) => users.map((user) => {
    const voiceRoom = roomByMemberId.get(user.userId);
    const voiceMember = voiceRoom ? voiceSnapshots[voiceRoom.id]?.members.find((member) => member.user.userId === user.userId) : undefined;
    const roleLabel = user.role === "owner" ? t("common.owner") : t("common.user");
    const detail = voiceRoom ? `${roleLabel} · ${voiceRoom.name}` : roleLabel;
    const canRename = canModerate && (user.role === "member" || user.userId === currentUser.id);
    const hasRemoteActions = user.userId !== currentUser.id && Boolean(voiceRoom || canModerate);
    const hasActions = hasRemoteActions || canRename;
    const canModerateRemote = canModerate && user.userId !== currentUser.id;
    const menuHeight = memberActionMenuHeight({
      hasVolume: Boolean(voiceRoom && user.userId !== currentUser.id),
      canRename,
      canDisconnect: Boolean(voiceRoom && canModerateRemote),
      canModerate: canModerateRemote,
      canVoiceModerate: Boolean(voiceRoom && canModerateRemote)
    });
    const menuKey = `directory-member:${user.userId}`;
    return (
      <div
        className={`member-row ${online ? "is-online" : "is-offline"}`}
        key={user.userId}
        onContextMenu={hasActions ? (event) => openSidebarMenuFromPointer(event, actionMenu, menuKey, 220, menuHeight) : undefined}
      >
        <span className={`avatar ${user.role === "owner" ? "owner" : ""}`}>{initial(user.nickname)}</span>
        <span className="member-copy"><strong>{user.nickname}</strong><span>{detail}</span></span>
        {hasActions ? (
          <MemberActionMenu
            actionMenu={actionMenu}
            menuKey={menuKey}
            member={user}
            volume={voiceRoom && user.userId !== currentUser.id ? memberVolumes[user.userId] ?? DEFAULT_VOLUME_PERCENT : undefined}
            onVolumeChange={voiceRoom && user.userId !== currentUser.id ? (volume) => onMemberVolumeChange(user.userId, volume) : undefined}
            canRename={canRename}
            canDisconnect={Boolean(voiceRoom && canModerateRemote)}
            canModerate={canModerateRemote}
            moderation={voiceRoom && canModerateRemote ? voiceMember?.moderation : undefined}
            onVoiceModeration={voiceRoom && canModerateRemote ? (moderation) => { void onVoiceModeration(user.userId, moderation); } : undefined}
            onRename={(returnFocus) => onRequestNickname(user, returnFocus)}
            onRequestAction={(action) => onRequestMemberAction(user, action, action === "disconnect" ? voiceRoom?.id : undefined)}
            t={t}
          />
        ) : null}
      </div>
    );
  });
  return (
    <aside className="member-panel">
      <section className="member-section">
        <div className="member-section-head"><span className="label">{t("common.online")}</span><span className="badge">{groupedMembers.online.length}</span></div>
        {groupedMembers.online.length === 0 ? (
          <p className="muted small">{t("room.presenceWaiting")}</p>
        ) : renderMembers(groupedMembers.online, true)}
      </section>
      {groupedMembers.offline.length > 0 ? <section className="member-section member-section-offline">
        <div className="member-section-head"><span className="label">{t("common.offline")}</span><span className="badge">{groupedMembers.offline.length}</span></div>
        {renderMembers(groupedMembers.offline, false)}
      </section> : null}
    </aside>
  );
}

function RoomHeader({ title, subtitle, actionLabel, onAction }: { title: string; subtitle: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <header className="room-header">
      <div className="room-title"><strong>{title}</strong><span className="muted small">{subtitle}</span></div>
      <div className="room-actions">
        {actionLabel && onAction ? <button className="btn btn-ghost" type="button" onClick={onAction}><ChatIcon /><span>{actionLabel}</span></button> : null}
      </div>
    </header>
  );
}

function VoiceDock(props: ShellProps & { connectedCount: number }) {
  const canManageServer = activeServerRole(props) === "owner";
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const roomName = props.activeVoiceRoomId ? props.t("room.lobbyVoice") : props.t("common.offline");
  const canJoinCurrentVoice = !props.activeVoiceRoomId && props.route.name === "voice";
  const micControl = controlPresentation("mic", props.controls);
  const deafenControl = controlPresentation("deafen", props.controls);
  const cameraControl = controlPresentation("camera", props.controls);
  const screenControl = controlPresentation("screenShare", props.controls);
  return (
    <footer className="voice-dock">
      <div className="dock-room">
        <ConnectionSignal health={props.connectionHealth} t={props.t} />
        <span className="dock-status"><strong>{roomName}</strong><span className="muted small">{props.activeVoiceRoomId ? `${voiceDockStatusLabel(props.controls, props.connectedCount, props.t)} · ${connectionLabel(props.socketState, props.t)}` : connectionCopy(props.socketState, props.t)}</span></span>
      </div>
      <div className="dock-controls">
        {canJoinCurrentVoice ? (
          <button className="btn btn-primary" type="button" disabled={props.socketState !== "live"} onClick={() => props.onJoinVoice(props.currentRoom?.id ?? "lobby")}><HeadsetIcon off={false} /><span>{props.t("room.joinCurrentVoice")}</span></button>
        ) : null}
        {props.activeVoiceRoomId ? (
          <>
            {props.voiceModeration.muted
              ? <ControlButton label={props.t("member.ownerMuted")} active tone="danger" enabled={false} onClick={() => undefined}><MicIcon off /></ControlButton>
              : <ControlButton label={props.t(`common.${micControl.action}` as TranslationKey)} active={props.controls.mic.on} tone={micControl.tone} enabled={props.controls.mic.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("mic")}><MicIcon off={!props.controls.mic.on} /></ControlButton>}
            {props.voiceModeration.deafened
              ? <ControlButton label={props.t("member.ownerDeafened")} active tone="danger" enabled={false} onClick={() => undefined}><HeadsetIcon off /></ControlButton>
              : <ControlButton label={props.t(`common.${deafenControl.action}` as TranslationKey)} active={props.controls.deafen.on} tone={deafenControl.tone} enabled={props.controls.deafen.enabled && !props.microphoneTestActive && props.socketState === "live"} onClick={() => props.onToggleControl("deafen")}><HeadsetIcon off={props.controls.deafen.on} /></ControlButton>}
            <ControlButton label={props.t(`common.${cameraControl.action}` as TranslationKey)} active={props.controls.camera.on} tone={cameraControl.tone} enabled={props.controls.camera.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("camera")}><CameraIcon off={!props.controls.camera.on} /></ControlButton>
            <ControlButton label={props.t(`common.${screenControl.action}` as TranslationKey)} active={props.controls.screenShare.on} tone={screenControl.tone} enabled={props.controls.screenShare.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("screenShare")}><ScreenIcon off={props.controls.screenShare.on} /></ControlButton>
            <button className="btn btn-danger" type="button" onClick={props.onLeaveVoice}><LeaveIcon /><span>{props.t("common.leave")}</span></button>
          </>
        ) : null}
      </div>
      <div className="dock-self">
        {canManageServer ? (
          <NavLink className="btn btn-ghost" href={`/app/server/${encodeURIComponent(props.activeServerId)}/owner`} onNavigate={props.onNavigate}><ShieldIcon /><span>{props.t("owner.panel")}</span></NavLink>
        ) : null}
        <details className="account-menu">
          <summary aria-label={`${props.currentNickname} account menu`}>
            <span className={`avatar ${props.user.role === "owner" ? "owner" : ""}`} title={props.currentNickname}>{initial(props.currentNickname)}</span>
          </summary>
          <div className="account-menu-panel">
            <strong>{props.currentNickname}</strong>
            <button className="btn btn-danger" type="button" onClick={() => setConfirmingLogout(true)}>{props.t("common.logout")}</button>
          </div>
        </details>
      </div>
      {confirmingLogout ? <ConfirmDialog title="Sign out?" copy="You will need a new access link to return on this device." confirmLabel={props.t("common.logout")} onCancel={() => setConfirmingLogout(false)} onConfirm={() => { setConfirmingLogout(false); void props.onLogout(); }} /> : null}
    </footer>
  );
}

function ConnectionSignal({ health, t }: { health: ConnectionHealth; t: Translate }) {
  const tone = health.quality === "good" ? "good" : health.quality === "fair" || health.quality === "measuring" ? "fair" : "poor";
  const label = health.rttMs === null ? t("connection.measuring") : t("connection.latency", { value: Math.round(health.rttMs) });
  return (
    <span className={`connection-signal is-${tone}`} role="status" aria-label={label}>
      <svg viewBox="0 0 20 16" aria-hidden="true">
        <rect x="1" y="11" width="3" height="4" rx="1" />
        <rect x="6" y="8" width="3" height="7" rx="1" />
        <rect x="11" y="4" width="3" height="11" rx="1" />
        <rect x="16" y="1" width="3" height="14" rx="1" />
      </svg>
      <span>{health.rttMs === null ? "-- ms" : `${Math.round(health.rttMs)} ms`}</span>
    </span>
  );
}

function ReconnectOverlay({ health, t }: { health: ConnectionHealth; t: Translate }) {
  const copy = health.reason === "browser_offline"
    ? t("connection.browserOffline")
    : health.reconnectAttempt > 0
      ? t("connection.retryAttempt", { count: health.reconnectAttempt })
      : t("connection.serverUnreachable");
  return (
    <div className="reconnect-overlay" role="status" aria-live="assertive">
      <img className="reconnect-logo" src="/brand/logo-mark.svg" alt="" width="72" height="72" />
      <strong>{t("connection.reconnecting")}</strong>
      <span>{copy}</span>
    </div>
  );
}

function ConfirmDialog({ title, copy, confirmLabel, cancelLabel = "Cancel", confirmationText, confirmationLabel, onCancel, onConfirm }: { title: string; copy: string; confirmLabel: string; cancelLabel?: string; confirmationText?: string; confirmationLabel?: string; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [confirmationValue, setConfirmationValue] = useState("");
  const isConfirmationValid = !confirmationText || confirmationValue === confirmationText;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmDialogTitle" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="confirmDialogTitle">{title}</h2>
        <p>{copy}</p>
        {confirmationText ? (
          <label className="form-field" htmlFor="confirmDialogValue">
            <span className="label">{confirmationLabel}</span>
            <input
              className="input"
              id="confirmDialogValue"
              value={confirmationValue}
              onChange={(event) => setConfirmationValue(event.currentTarget.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}
        <div className="confirm-actions">
          <button className="btn btn-ghost" type="button" ref={cancelRef} onClick={onCancel}>{cancelLabel}</button>
          <button className="btn btn-danger" type="button" disabled={!isConfirmationValid} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

function NicknameDialog({ user, returnFocus, t, onCancel, onSave }: {
  user: PresenceUser;
  returnFocus?: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onSave: (nickname: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState(user.nickname);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const close = useCallback(() => {
    onCancel();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onCancel, returnFocus]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isSaving]);

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={() => { if (!isSaving) close(); }}>
      <form className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="nicknameDialogTitle" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => {
        event.preventDefault();
        const nextNickname = nickname.trim();
        if (nextNickname.length < 2 || nextNickname.length > 32) {
          setError(t("member.nicknameLength"));
          return;
        }
        setIsSaving(true);
        setError("");
        void onSave(nextNickname)
          .then(() => window.setTimeout(() => returnFocus?.focus(), 0))
          .catch(() => setError(t("member.nicknameUpdateFailed")))
          .finally(() => setIsSaving(false));
      }}>
        <h2 id="nicknameDialogTitle">{t("member.changeNickname")}</h2>
        <label className="form-field" htmlFor="nicknameDialogValue">
          <span>{t("member.nicknameLabel")}</span>
          <input
            className="input"
            id="nicknameDialogValue"
            ref={inputRef}
            value={nickname}
            minLength={2}
            maxLength={32}
            autoComplete="nickname"
            onChange={(event) => setNickname(event.currentTarget.value)}
          />
        </label>
        <p className={error ? "error-text" : "muted small"} aria-live="polite">{error || t("member.nicknameLength")}</p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" type="button" disabled={isSaving} onClick={close}>{t("common.cancel")}</button>
          <button className="btn btn-primary" type="submit" disabled={isSaving}>{t("member.changeNickname")}</button>
        </div>
      </form>
    </div>
  );
}

function InviteScreen({ initialToken, existingUser, currentUser, turnstileSiteKey, onAccepted, language, t, onLanguageChange }: { initialToken: string; existingUser: boolean; currentUser: PublicUser | null; turnstileSiteKey: string | null; onAccepted: (user: PublicUser, serverId: string) => void; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  const [inviteToken, setInviteToken] = useState(initialToken);
  const [serverName, setServerName] = useState("");
  const [invitePreview, setInvitePreview] = useState<{ expiresAt: string | null; remainingUses: number | null } | null>(null);
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState<"ready" | "loading" | "valid" | "danger">("ready");
  const [fieldError, setFieldError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const onTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
    setFieldError("");
  }, []);
  const onTurnstileUnavailable = useCallback(() => {
    setTurnstileToken("");
    setFieldError(t("invite.turnstileUnavailable"));
  }, [t]);

  useEffect(() => {
    const token = extractInviteToken(initialToken);
    if (token.length < 24) {
      setServerName("");
      setInvitePreview(null);
      return;
    }
    let cancelled = false;
    void previewInvite(extractInviteToken(initialToken))
      .then((response) => {
        if (!cancelled) {
          setServerName(response.serverName);
          setInvitePreview({ expiresAt: response.expiresAt, remainingUses: response.remainingUses });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerName("");
          setInvitePreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!existingUser && !nickname.trim()) {
      setFieldError(t("invite.chooseNicknameError"));
      return;
    }
    if (!inviteToken.trim()) {
      setFieldError(t("invite.pasteError"));
      return;
    }
    if (turnstileSiteKey && !existingUser && !turnstileToken) {
      setFieldError(t("invite.turnstileRequired"));
      return;
    }

    setFieldError("");
    setStatus("loading");
    try {
      const response = await acceptInvite(extractInviteToken(inviteToken), nickname.trim(), turnstileToken || undefined);
      setStatus("valid");
      onAccepted(response.user, response.serverId);
    } catch (error: unknown) {
      setStatus("danger");
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileResetKey((current) => current + 1);
      }
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        setFieldError(t("invite.turnstileFailed"));
      } else if (error instanceof ApiError && error.code === "already_server_member") {
        const serverId = error.data?.serverId;
        if (currentUser && typeof serverId === "string") {
          onAccepted(currentUser, serverId);
          return;
        }
        setFieldError(t("invite.alreadyMember"));
      } else if (error instanceof ApiError && error.code === "server_banned") {
        setFieldError(t("invite.serverBanned"));
      } else {
        setFieldError(t("invite.unavailable"));
      }
    }
  }

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{serverName ? t("invite.joinServerTitle", { server: serverName }) : t("invite.joinTitle")}</h1>
            <p className="muted small">{existingUser ? t("invite.joinExistingCopy") : t("invite.chooseName")}</p>
          </div>
          <div className={`invite-status ${statusClass(status)}`} aria-live="polite">
            <strong>{inviteStatusTitle(status, t)}</strong>
            <span className="muted small">{status === "danger" ? t("invite.askOwner") : inviteAvailabilityCopy(invitePreview, language, t)}</span>
          </div>
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="inviteLink">
              <span>{t("invite.codeLabel")}</span>
              <input className="input" id="inviteLink" name="inviteLink" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="VX-7K2M…" />
            </label>
            {!existingUser ? <label className="form-field field-gap" htmlFor="nickname">
              <span>{t("invite.nickname")}</span>
              <input className="input" id="nickname" name="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Wren…" autoComplete="nickname" maxLength={32} />
            </label> : null}
            {turnstileSiteKey && !existingUser ? (
              <div className="form-field field-gap">
                <span>{t("invite.humanCheck")}</span>
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  resetKey={turnstileResetKey}
                  onToken={onTurnstileToken}
                  onUnavailable={onTurnstileUnavailable}
                />
              </div>
            ) : null}
            <p className="error-text" aria-live="polite">{fieldError}</p>
            <button className="btn btn-primary full-width" type="submit" disabled={status === "loading"}><ArrowIcon /><span>{status === "loading" ? t("common.checking") : t("invite.join")}</span></button>
          </form>
        </section>
      </div>
    </main>
  );
}

function TurnstileWidget({ siteKey, resetKey, onToken, onUnavailable }: { siteKey: string; resetKey: number; onToken: (token: string) => void; onUnavailable: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isActive = true;
    let widgetId: string | null = null;
    onToken("");

    loadTurnstile()
      .then((turnstile) => {
        if (!isActive || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => {
            if (isActive) onToken(token);
          },
          "expired-callback": () => {
            if (isActive) onToken("");
          },
          "error-callback": () => {
            if (isActive) onUnavailable();
          }
        });
      })
      .catch(() => {
        if (isActive) onUnavailable();
      });

    return () => {
      isActive = false;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [onToken, onUnavailable, resetKey, siteKey]);

  return <div className="turnstile-widget" ref={containerRef} />;
}

function OwnerClaimScreen({ token, language, t, onLanguageChange, onClaimed }: { token: string; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onClaimed: (user: PublicUser) => void }) {
  const [status, setStatus] = useState<"loading" | "danger">("loading");

  useEffect(() => {
    let isMounted = true;
    if (!token) {
      setStatus("danger");
      return;
    }

    claimOwnerSession(token)
      .then((response) => {
        if (isMounted) {
          onClaimed(response.user);
        }
      })
      .catch(() => {
        if (isMounted) {
          setStatus("danger");
        }
      });

    return () => {
      isMounted = false;
    };
  }, [onClaimed, token]);

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle="Owner setup" />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("ownerClaim.label")}</p>
            <h1>{t("ownerClaim.title")}</h1>
            <p className="muted small">{t("ownerClaim.copy")}</p>
          </div>
          <div className={`invite-status ${status === "danger" ? "is-danger" : "is-loading"}`} aria-live="polite">
            <strong>{status === "danger" ? t("ownerClaim.invalid") : t("ownerClaim.checking")}</strong>
            <span className="muted small">{status === "danger" ? t("ownerClaim.invalidCopy") : t("ownerClaim.checkingCopy")}</span>
          </div>
        </section>
      </div>
    </main>
  );
}

function AccessClaimScreen({ token, t, onNavigate, onClaimed }: { token: string; t: Translate; onNavigate: (path: string) => void; onClaimed: (user: PublicUser, serverId: string) => void }) {
  const [status, setStatus] = useState<"loading" | "danger">("loading");

  useEffect(() => {
    let isMounted = true;
    if (!token) {
      setStatus("danger");
      return;
    }
    claimAccessLink(token)
      .then((response) => {
        if (isMounted) onClaimed(response.user, response.serverId);
      })
      .catch(() => {
        if (isMounted) setStatus("danger");
      });
    return () => {
      isMounted = false;
    };
  }, [onClaimed, token]);

  return (
    <main className="invite-shell">
      <section className="invite-card">
        <BrandLockup />
        <div className={`invite-status ${status === "danger" ? "is-danger" : "is-loading"}`} aria-live="polite">
          <strong>{status === "danger" ? "Access link is invalid" : "Restoring your account…"}</strong>
          <span className="muted small">{status === "danger" ? "Ask the server owner for a new access link." : "This secure link can be used once."}</span>
        </div>
        {status === "danger" ? <NavLink className="btn btn-primary full-width" href="/invite" onNavigate={onNavigate}><span>{t("landing.haveInvite")}</span></NavLink> : null}
      </section>
    </main>
  );
}

function MessageItem({
  message,
  user,
  language,
  t,
  onUpdate,
  onDelete,
  onSuppressEmbed
}: {
  message: ChatMessage;
  user: PublicUser;
  language: LanguageCode;
  t: Translate;
  onUpdate: (messageId: string, body: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingEmbed, setPendingEmbed] = useState<MessageEmbed | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const permissions = messagePermissions({
    currentUserId: user.id,
    currentUserRole: user.role,
    messageUserId: message.userId
  });
  const isOwn = message.userId === user.id;
  const hasActions = permissions.canEdit || permissions.canDelete;
  const contentSegments = messageContentSegments(message.body);
  const embeds = messageEmbeds(message.body, message.suppressedEmbedKeys);

  useEffect(() => {
    if (!menuPosition) return;

    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPosition(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuPosition(null);
      menuTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuPosition]);

  function openMenu(x: number, y: number) {
    setMenuPosition(clampContextMenuPosition({
      x,
      y,
      menuWidth: 160,
      menuHeight: permissions.canEdit && permissions.canDelete ? 92 : 50,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
  }

  async function saveEdit() {
    const body = draft.trim();
    if (!body) return;
    setIsBusy(true);
    setActionError("");
    try {
      await onUpdate(message.id, body);
      setIsEditing(false);
    } catch {
      setActionError(t("room.messageCouldNotSend"));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteCurrentMessage() {
    setIsBusy(true);
    setActionError("");
    try {
      await onDelete(message.id);
    } catch (error) {
      setActionError(messageDeleteFailureCopy(error instanceof ApiError ? error.status : undefined, t));
    } finally {
      setIsBusy(false);
    }
  }

  async function suppressCurrentEmbed(embed: MessageEmbed) {
    setIsBusy(true);
    setActionError("");
    try {
      await onSuppressEmbed(message.id, embed.key);
    } catch {
      setActionError(t("room.suppressEmbedError"));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <article
      className={`message ${isOwn ? "message-own" : ""}`}
      onContextMenu={hasActions ? (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      } : undefined}
    >
      <span className={`avatar ${isOwn ? "owner" : ""}`}>{initial(message.nickname)}</span>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{message.nickname}</span>
          <span className="message-time mono">
            <time dateTime={message.createdAt}>{formatMessageTimestamp(message.createdAt, language)}</time>
            {message.editedAt ? (
              <span
                className="message-edited"
                title={t("room.editedAt", { time: formatMessageDateTime(message.editedAt, language) })}
              >({t("status.edited")})</span>
            ) : null}
          </span>
        </div>
        {isEditing ? (
          <div className="message-edit">
            <textarea className="textarea" aria-label={t("common.edit")} value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} />
            <div className="message-actions">
              <button className="btn btn-primary" type="button" disabled={isBusy} onClick={saveEdit}>{t("common.save")}</button>
              <button className="btn btn-ghost" type="button" disabled={isBusy} onClick={() => { setDraft(message.body); setIsEditing(false); }}>{t("common.cancel")}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="message-body">{contentSegments.map((segment, index) => segment.kind === "link" ? (
              <a href={segment.href} target="_blank" rel="noopener noreferrer" key={`${segment.href}:${index}`}>{segment.text}</a>
            ) : <span key={`text:${index}`}>{segment.text}</span>)}</div>
            {embeds.length > 0 ? <div className="message-rich-embeds">
              {embeds.map((embed) => {
                const provider = embedProviderLabel(embed.provider);
                return <section className={`message-embed is-${embed.provider}`} key={embed.key}>
                  <header className="message-embed-head">
                    <a href={embed.sourceUrl} target="_blank" rel="noopener noreferrer">{provider}</a>
                    {permissions.canDelete ? <button
                      className="message-embed-close"
                      type="button"
                      aria-label={t("room.suppressEmbed", { provider })}
                      title={t("room.suppressEmbed", { provider })}
                      disabled={isBusy}
                      onClick={() => setPendingEmbed(embed)}
                    ><CloseIcon /></button> : null}
                  </header>
                  <iframe
                    src={embed.embedUrl}
                    title={t("room.embedTitle", { provider })}
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    allowFullScreen
                  />
                </section>;
              })}
            </div> : null}
          </>
        )}
        {actionError ? <p className="error-text" aria-live="polite">{actionError}</p> : null}
      </div>
      {!isEditing && hasActions ? (
        <button
          ref={menuTriggerRef}
          className="message-menu-trigger"
          type="button"
          aria-label={t("room.messageActions")}
          aria-haspopup="menu"
          aria-expanded={menuPosition ? "true" : "false"}
          disabled={isBusy}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right - 160, rect.bottom + 4);
          }}
        >
          <MoreIcon />
        </button>
      ) : null}
      {menuPosition ? createPortal(
        <div
          ref={menuRef}
          className="message-context-menu"
          role="menu"
          aria-label={t("room.messageActions")}
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          {permissions.canEdit ? (
            <button role="menuitem" type="button" onClick={() => {
              setMenuPosition(null);
              setDraft(message.body);
              setIsEditing(true);
            }}>{t("common.edit")}</button>
          ) : null}
          {permissions.canDelete ? (
            <button className="is-danger" role="menuitem" type="button" onClick={() => {
              setMenuPosition(null);
              setConfirmingDelete(true);
            }}>{t("common.delete")}</button>
          ) : null}
        </div>,
        document.body
      ) : null}
      {confirmingDelete ? <ConfirmDialog
        title={t("room.deleteMessageConfirm")}
        copy="This message will be permanently removed."
        confirmLabel={t("common.delete")}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void deleteCurrentMessage();
        }}
      /> : null}
      {pendingEmbed ? <ConfirmDialog
        title={t("room.suppressEmbedTitle")}
        copy={t("room.suppressEmbedCopy")}
        confirmLabel={t("room.suppressEmbedConfirm")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setPendingEmbed(null)}
        onConfirm={() => {
          const embed = pendingEmbed;
          setPendingEmbed(null);
          void suppressCurrentEmbed(embed);
        }}
      /> : null}
    </article>
  );
}

function embedProviderLabel(provider: MessageEmbed["provider"]) {
  if (provider === "youtube") return "YouTube";
  if (provider === "x") return "X / Twitter";
  if (provider === "vimeo") return "Vimeo";
  return "Spotify";
}

function PreferencesCard({
  language,
  theme,
  t,
  onLanguageChange,
  onThemeChange
}: {
  language: LanguageCode;
  theme: ThemeChoice;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
  onThemeChange: (theme: ThemeChoice) => void;
}) {
  return (
    <section className="theme-card">
      <div className="theme-card-head"><span className="label">{t("common.appearance")}</span><span className="small muted">{themeLabel(theme, t)}</span></div>
      <div className="theme-options" role="group" aria-label={t("common.appearance")}>
        {(["auto", "light", "dark"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={theme === option} onClick={() => onThemeChange(option)}>{themeLabel(option, t)}</button>
        ))}
      </div>
      <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
    </section>
  );
}

function LanguageSwitch({ language, t, onLanguageChange }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  return (
    <div className="language-switch">
      <div className="theme-card-head"><span className="label">{t("common.language")}</span></div>
      <div className="theme-options theme-options-compact" role="group" aria-label={t("common.language")}>
        {(["en", "tr"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={language === option} onClick={() => onLanguageChange(option)}>{languageLabel(option)}</button>
        ))}
      </div>
    </div>
  );
}

function ControlButton({ label, active, tone, enabled, onClick, children }: { label: string; active: boolean; tone: "neutral" | "danger"; enabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`icon-btn control-icon ${active ? "is-active" : "is-off"} ${tone === "danger" ? "is-danger-state" : ""}`} type="button" aria-pressed={active} aria-label={label} title={label} disabled={!enabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Toast({ message }: { message: string }) {
  const [visibleMessage, setVisibleMessage] = useState("");

  useEffect(() => {
    if (!message) return;
    setVisibleMessage(message);
    const timeout = window.setTimeout(() => setVisibleMessage(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  return visibleMessage ? <div className="toast toast-danger" role="alert">{visibleMessage}</div> : null;
}

function VoiceStatusBadges({ media, moderation, t, compact = false }: { media: VoiceMediaState | undefined; moderation?: VoiceModerationState; t: Translate; compact?: boolean }) {
  const items = voiceStatusItems(media, moderation, t);
  if (items.length === 0) {
    return null;
  }

  return (
    <span className={`voice-status-list ${compact ? "is-compact" : ""}`}>
      {items.map((item) => (
        <span className={`voice-status-chip ${item.tone}`} key={item.label}>
          {item.icon}
          <span>{item.label}</span>
        </span>
      ))}
    </span>
  );
}

function RemoteVideo({ stream, muted = false }: { stream: MediaStream; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return <video className="call-video" ref={videoRef} autoPlay playsInline muted={muted} />;
}

function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="volume-control">
      <span className="volume-control-label"><VolumeIcon /><span>{label}</span><strong>{value}%</strong></span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="200"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function RemoteAudio({ stream, muted, volume }: { stream: MediaStream; muted: boolean; volume: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputRef = useRef<AudioOutput | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || stream.getAudioTracks().length === 0) return;
    const output = connectAudioOutput(audio, stream, { muted, volume });
    outputRef.current = output;
    return () => {
      output.dispose();
      outputRef.current = null;
    };
  }, [stream]);

  useEffect(() => {
    outputRef.current?.setVolume(muted, volume);
  }, [muted, volume]);

  return <audio className="remote-audio" ref={audioRef} autoPlay muted={muted} />;
}

function AudioPlaybackRecovery({ t }: { t: Translate }) {
  return (
    <div className="audio-playback-recovery" role="status">
      <span>{t("audio.playbackBlocked")}</span>
      <button className="btn btn-primary" type="button" onClick={() => void retryBlockedAudioOutputs()}>
        {t("audio.enablePlayback")}
      </button>
    </div>
  );
}

function GlobalVoiceAudio({
  streams,
  muted,
  mutedUserIds,
  memberVolumes,
  outputVolume
}: {
  streams: RemoteStreamState[];
  muted: boolean;
  mutedUserIds: Set<string>;
  memberVolumes: Record<string, number>;
  outputVolume: number;
}) {
  return (
    <>
      {streams.filter((item) => item.kind === "audio").map((item) => (
        <RemoteAudio
          key={remoteStreamKey(item.userId, item.kind)}
          stream={item.stream}
          muted={muted || mutedUserIds.has(item.userId)}
          volume={combineOutputVolume(memberVolumes[item.userId] ?? DEFAULT_VOLUME_PERCENT, outputVolume)}
        />
      ))}
    </>
  );
}

function VisualStage({
  sources,
  focusedSource,
  screenVolumes,
  outputVolume,
  onFocus,
  onScreenVolumeChange,
  t
}: {
  sources: StageSource[];
  focusedSource: StageSource | null;
  screenVolumes: Record<string, number>;
  outputVolume: number;
  onFocus: (key: string) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  t: Translate;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const orderedSources = focusedSource
    ? [focusedSource, ...sources.filter((source) => source.key !== focusedSource.key)]
    : sources;
  const focusedStream = focusedSource?.stream ?? null;
  const focusedHasAudio = Boolean(focusedSource?.kind === "screen" && focusedStream?.getAudioTracks().length);
  const focusedVolume = focusedStream ? screenVolumes[focusedStream.id] ?? DEFAULT_VOLUME_PERCENT : DEFAULT_VOLUME_PERCENT;

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === stageRef.current) {
      void document.exitFullscreen?.();
      return;
    }
    void stageRef.current?.requestFullscreen?.();
  };

  return (
    <section ref={stageRef} className={`screen-stage stage-count-${Math.min(orderedSources.length, 4)}`} aria-label={t("voice.stage")}>
      <div className="stage-grid">
        {orderedSources.map((source) => (
          <button
            className={`stage-media ${source.key === focusedSource?.key ? "is-focused" : ""}`}
            type="button"
            key={source.key}
            onClick={() => onFocus(source.key)}
            aria-pressed={source.key === focusedSource?.key}
            aria-label={`${source.ownerName} ${source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}`}
          >
            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span className="screen-stage-placeholder">{source.connectionStatus === "failed" ? t("voice.retry") : t("voice.connecting")}</span>}
            {source.key !== focusedSource?.key ? <span className="stage-media-label"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span> : null}
          </button>
        ))}
      </div>
      {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" && focusedStream && focusedHasAudio ? <RemoteAudio stream={focusedStream} muted={false} volume={combineOutputVolume(focusedVolume, outputVolume)} /> : null}
      <div className="screen-stage-bar">
        <span><strong>{focusedSource?.ownerName}</strong><span className="muted small">{focusedSource?.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span>
        {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" ? (
          focusedHasAudio && focusedStream
            ? <details className="volume-popover stage-volume"><summary aria-label={t("voice.screenVolume")}><VolumeIcon /></summary><VolumeControl label={t("voice.screenVolume")} value={focusedVolume} onChange={(volume) => onScreenVolumeChange(focusedStream.id, volume)} /></details>
            : <button className="icon-btn screen-audio-unavailable" type="button" disabled aria-label={t("voice.noScreenAudio")} title={t("voice.noScreenAudio")}><VolumeIcon /></button>
        ) : null}
        <button className="icon-btn" type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit full screen" : t("common.fullscreen")}>
          <MaximizeIcon />
          <span>{isFullscreen ? "Exit full screen" : t("common.fullscreen")}</span>
        </button>
      </div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: "live" | "online" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function MemberRow({ user, detail, owner }: { user: string; detail: string; owner?: boolean }) {
  return (
    <span className="member-row">
      <span className={`avatar ${owner ? "owner" : ""}`}>{initial(user)}</span>
      <span className="member-copy"><strong>{user}</strong><span>{detail}</span></span>
    </span>
  );
}

function BrandLockup({ title = "Voxly", subtitle = "The Basement", href = "/", onNavigate, onClick }: { title?: string; subtitle?: string; href?: string; onNavigate?: (path: string) => void; onClick?: () => void }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onNavigate) {
      linkHandler(href, onNavigate)(event);
      return;
    }
    if (onClick) {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <a className="brand-lockup brand-button" href={href} onClick={handleClick}>
      <span className="brand-mark"><img src="/brand/logo-mark.svg" alt="" width="28" height="28" /></span>
      <span className="brand-copy"><strong>{title}</strong>{subtitle ? <span>{subtitle}</span> : null}</span>
    </a>
  );
}

function NavLink({ href, className, onNavigate, onClick, children }: {
  href: string;
  className: string;
  onNavigate: (path: string) => void;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  const navigateOnClick = linkHandler(href, onNavigate);
  return <a className={className} href={href} onClick={(event) => {
    onClick?.(event);
    navigateOnClick(event);
  }}>{children}</a>;
}

function linkHandler(href: string, onNavigate: (path: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><h3>{title}</h3><p className="muted">{copy}</p></div>;
}

function FatalState({ t }: { t: Translate }) {
  return <main className="invite-shell"><section className="invite-card"><BrandLockup /><div className="invite-status is-danger"><strong>{t("system.couldNotStart")}</strong><span className="muted small">{t("system.checkBackend")}</span></div></section></main>;
}

function parseRoute(pathname: string): Route {
  const route = parsePathRoute(pathname);
  if (route.name === "owner-claim") return { name: "owner-claim", token: getOwnerClaimTokenFromHash(window.location.hash) };
  return route;
}

function serverPath(serverId: string, kind: "text" | "voice", roomId: string) {
  return `/app/server/${encodeURIComponent(serverId)}/${kind}/${encodeURIComponent(roomId)}`;
}

function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

function saveThemeChoice(theme: ThemeChoice) {
  try {
    if (theme === "auto") localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, theme);
  } catch {
    return;
  }
}

function applyThemeChoice(theme: ThemeChoice) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function activeServerRole(props: Pick<ShellProps, "activeServerId" | "servers">) {
  return props.servers.find((server) => server.id === props.activeServerId)?.role ?? null;
}

function includeCurrentPresence(users: PresenceUser[], user: PublicUser) {
  return upsertPresence(users, presenceFromUser(user), user);
}

function upsertPresence(users: PresenceUser[], next: PresenceUser, currentUser: PublicUser) {
  const withCurrent = users.some((item) => item.userId === currentUser.id) ? users : [presenceFromUser(currentUser), ...users];
  return withCurrent.some((item) => item.userId === next.userId)
    ? withCurrent.map((item) => (item.userId === next.userId ? next : item))
    : [...withCurrent, next];
}

function presenceFromUser(user: PublicUser, nickname = user.nickname): PresenceUser {
  return { userId: user.id, nickname, role: user.role };
}

function connectionLabel(state: ShellProps["socketState"], t: Translate) {
  if (state === "live") return t("connection.live");
  if (state === "reconnecting") return t("connection.reconnecting");
  if (state === "offline") return t("connection.offline");
  return t("connection.connecting");
}

function connectionCopy(state: ShellProps["socketState"], t: Translate) {
  if (state === "live") return t("connection.liveCopy");
  if (state === "reconnecting") return t("connection.reconnectingCopy");
  if (state === "offline") return t("connection.offlineCopy");
  return t("connection.connectingCopy");
}

function statusClass(status: "ready" | "loading" | "valid" | "danger") {
  if (status === "loading") return "is-loading";
  if (status === "danger") return "is-danger";
  return "is-valid";
}

function inviteStatusTitle(status: "ready" | "loading" | "valid" | "danger", t: Translate) {
  if (status === "loading") return t("invite.checking");
  if (status === "danger") return t("invite.unavailable");
  if (status === "valid") return t("invite.accepted");
  return t("invite.ready");
}

function inviteAvailabilityCopy(preview: { expiresAt: string | null; remainingUses: number | null } | null, language: LanguageCode, t: Translate) {
  if (!preview) return t("invite.checking");
  const uses = preview.remainingUses === null
    ? t("invite.unlimitedUses")
    : t("invite.remainingUses", { count: preview.remainingUses });
  return `${uses} · ${formatShortDate(preview.expiresAt, language, t)}`;
}

function isInviteRevocable(invite: OwnerInvite) {
  if (invite.revokedAt || (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now())) return false;
  return invite.maxUses === null || invite.usedCount < invite.maxUses;
}

function inviteLifecycleKey(invite: OwnerInvite): TranslationKey {
  if (invite.revokedAt) return "common.revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return "invite.expired";
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return "invite.exhausted";
  return "common.active";
}

function extractInviteToken(value: string) {
  const trimmed = value.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function formatShortDate(value: string | null, language: LanguageCode, t: Translate) {
  if (!value) return t("common.noExpiry");
  return new Intl.DateTimeFormat(language, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function themeLabel(theme: ThemeChoice, t: Translate) {
  if (theme === "light") return t("common.light");
  if (theme === "dark") return t("common.dark");
  return t("common.auto");
}

function voiceDockStatusLabel(controls: VoiceControls, connectedCount: number, t: Translate) {
  if (controls.deafen.on) {
    return t("status.deafenedOutputOff");
  }

  if (!controls.mic.on) {
    return t("status.micMuted", { count: connectedCount });
  }

  return t("common.connected", { count: connectedCount });
}

function voiceStatusItems(media: VoiceMediaState | undefined, moderation: VoiceModerationState | undefined, t: Translate) {
  if (!media) return [];
  const items: Array<{ label: string; icon: ReactNode; tone: "danger" | "live" | "online" | "neutral" }> = [];
  if (moderation?.deafened) {
    items.push({ label: t("member.ownerDeafened"), icon: <HeadsetIcon off />, tone: "danger" });
  }
  if (moderation?.muted) {
    items.push({ label: t("member.ownerMuted"), icon: <MicIcon off />, tone: "danger" });
  }
  if (media.deafened) {
    items.push({ label: t("common.deafened"), icon: <HeadsetIcon off />, tone: "neutral" });
  }
  if ((!media.mic || media.deafened) && !moderation?.muted) {
    items.push({ label: t("common.muted"), icon: <MicIcon off />, tone: "neutral" });
  }
  if (media.screen) {
    items.push({ label: t("status.screenSharing"), icon: <ScreenIcon off={false} />, tone: "live" });
  } else if (media.camera) {
    items.push({ label: t("status.cameraOn"), icon: <CameraIcon off={false} />, tone: "online" });
  }
  if (media.speaking && media.mic && !media.deafened && !moderation?.muted) {
    items.push({ label: t("status.speaking"), icon: <span className="status-dot speaking" />, tone: "live" });
  }
  return items;
}

function voiceMembersForRoom(props: ShellProps, roomId: string) {
  if (props.voiceSnapshots[roomId]) {
    return props.voiceSnapshots[roomId].members;
  }
  if (props.activeVoiceRoomId === roomId) {
    return [{
      user: presenceFromUser(props.user, props.currentNickname),
      media: {
        mic: props.controls.mic.on,
        camera: props.controls.camera.on,
        screen: props.controls.screenShare.on,
        deafened: props.controls.deafen.on,
        speaking: false
      },
      moderation: props.voiceModeration
    }];
  }
  return [];
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage) {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next].slice(-200);
}

function initial(value: string) {
  return value.trim().charAt(0).toUpperCase() || "V";
}

function ArrowIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>; }
function ChatIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H9l-4 4z" /></svg>; }
function MenuIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></svg>; }
function UsersIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" /><circle cx="12" cy="9" r="3" /></svg>; }
function ShieldIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 19 7v5c0 4-2.7 6.7-7 8-4.3-1.3-7-4-7-8V7z" /><path d="M9 12h6" /></svg>; }
function PlusIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>; }
function CopyIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v10H8z" /><path d="M6 14H5a1 1 0 0 1-1-1V5h8a1 1 0 0 1 1 1v1" /></svg>; }
function CloseIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>; }
function EditIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 16-1 4 4-1L19 8l-3-3Z" /><path d="m14 7 3 3" /></svg>; }
function TrashIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12" /><path d="M9 7V5h6v2" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M8 7l1 12h6l1-12" /></svg>; }
function LeaveIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8 4 12l4 4" /><path d="M4 12h11" /><path d="M14 5h5v14h-5" /></svg>; }
function MaximizeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M21 16v5h-5" /><path d="M3 16v5h5" /></svg>; }
function EyeIcon({ off = false }: { off?: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" /><circle cx="12" cy="12" r="2.5" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function MoreIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>; }
function VolumeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h4l5-4v12l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M19 6a8 8 0 0 1 0 12" /></svg>; }
function MicIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v3" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function HeadsetIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 14v-2a7 7 0 0 1 14 0v2" /><path d="M5 14h3v5H6a1 1 0 0 1-1-1z" /><path d="M16 14h3v4a1 1 0 0 1-1 1h-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function CameraIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4z" /><path d="m17 11 3-2v6l-3-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function ScreenIcon({ off }: { off: boolean }) {
  return (
    <svg className="ui-icon screen-icon" viewBox="0 0 256 256" aria-hidden="true">
      <rect x="32" y="48" width="192" height="144" rx="16" transform="translate(256 240) rotate(180)" />
      <line x1="160" y1="224" x2="96" y2="224" />
      <polyline points="104 112 128 88 152 112" />
      <line x1="128" y1="88" x2="128" y2="152" />
      {off ? <line x1="32" y1="32" x2="224" y2="224" /> : null}
    </svg>
  );
}
