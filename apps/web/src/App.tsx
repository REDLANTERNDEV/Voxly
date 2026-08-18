import type { ChatMessage,PublicUser } from "@voxly/shared";
import { useCallback,useEffect,useRef,useState,type ReactNode } from "react";
import { logout } from "./api.js";
import { AppRoutes } from "./app/AppRoutes.js";
import { AuthenticatedAppSurface } from "./app/AuthenticatedAppSurface.js";
import { applyThemeChoice,parseRoute,readThemeChoice,saveThemeChoice,serverPath } from "./app/navigation.js";
import type { Drawer,LiveWatchRequest,Route,ShellActions,ShellModel,ThemeChoice,Translate,VoiceJoinRequest } from "./app/types.js";
import { useListenerAudio } from "./app/useListenerAudio.js";
import { useRealtimeSync } from "./app/useRealtimeSync.js";
import { useSessionController } from "./app/useSessionController.js";
import { useWorkspaceController } from "./app/useWorkspaceController.js";
import { useChatController } from "./features/chat/useChatController.js";
import { useIdlePresence } from "./app/useIdlePresence.js";
import { AudioPlaybackRecovery,GlobalVoiceAudio,RemoteAudio } from "./features/voice/VoicePresentation.js";
import { joinVoiceWithAudioUnlock } from "./features/voice/voiceActions.js";
import { combineOutputVolume } from "./lib/audioLevels.js";
import { releaseUnusedSharedAudioOutput,unlockSharedAudioOutput } from "./lib/audioOutput.js";
import { readRoomHistory,type RoomHistory } from "./lib/channelState.js";
import { readLanguageChoice,saveLanguageChoice,translate,type LanguageCode } from "./lib/i18n.js";
import { defaultServerId } from "./lib/navigation.js";
import { DEFAULT_VOLUME_PERCENT } from "./lib/voiceVolume.js";

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [theme, setTheme] = useState<ThemeChoice>(() => readThemeChoice());
  const [language, setLanguage] = useState<LanguageCode>(() => readLanguageChoice());
  const [roomHistory, setRoomHistory] = useState<RoomHistory>(() => readRoomHistory(window.localStorage));
  const routeRef = useRef(route);
  const roomServerIdsRef = useRef<Record<string, string>>({});
  const activeVoiceRoomRef = useRef<string | null>(null);
  const leaveVoiceRef = useRef<() => void>(() => undefined);
  const moveVoiceRef = useRef<(roomId: string) => void>(() => undefined);
  const notifyMessageRef = useRef<(message: ChatMessage) => void>(() => undefined);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    const nextRoute = parseRoute(path);
    routeRef.current = nextRoute;
    setRoute(nextRoute);
    setDrawer(null);
  }, []);
  const t = useCallback<Translate>((key, values) => translate(language, key, values), [language]);
  const changeLanguage = useCallback((next: LanguageCode) => {
    saveLanguageChoice(next);
    setLanguage(next);
  }, []);
  const changeTheme = useCallback((next: ThemeChoice) => {
    saveThemeChoice(next);
    setTheme(next);
  }, []);

  useEffect(() => {
    const handlePop = () => {
      const nextRoute = parseRoute(window.location.pathname);
      routeRef.current = nextRoute;
      setRoute(nextRoute);
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);
  useEffect(() => applyThemeChoice(theme), [theme]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const session = useSessionController(route, navigate);
  const workspace = useWorkspaceController({
    user: session.user,
    route,
    navigate,
    roomHistory,
    roomServerIdsRef,
    routeRef
  });
  const handleOwnerClaimed = useCallback((claimed: PublicUser) => {
    session.completeAuthentication(claimed);
    navigate(`/app/server/${defaultServerId}/owner`);
  }, [navigate, session.completeAuthentication]);
  const handleAccessClaimed = useCallback((claimed: PublicUser, serverId: string) => {
    session.completeAuthentication(claimed);
    void workspace.loadAcceptedServer(serverId).catch(() => navigate("/"));
  }, [navigate, session.completeAuthentication, workspace.loadAcceptedServer]);
  const chat = useChatController({
    user: session.user,
    route,
    currentRoom: workspace.currentRoom,
    roomServerIds: roomServerIdsRef,
    roomHistory,
    setRoomHistory
  });
  const realtime = useRealtimeSync({
    user: session.user,
    route,
    activeVoiceRoomRef,
    leaveVoiceRef,
    moveVoiceRef,
    handlers: {
      presenceSnapshot: workspace.applyPresenceSnapshot,
      presenceOnline: workspace.applyPresenceOnline,
      presenceOffline: workspace.applyPresenceOffline,
      presenceStatus: workspace.applyPresenceStatus,
      directoryChanged: (serverId) => { void workspace.refreshServerDirectory(serverId).catch(() => undefined); },
      memberUpdated: (serverId, user) => {
        workspace.applyMemberUpdate(serverId, user);
        chat.applyMemberRename(serverId, user);
      },
      serverUpdated: workspace.applyServerName,
      afkUpdated: workspace.applyAfkTimeout,
      roomsChanged: (serverId, roomId) => { void workspace.refreshRooms(serverId, roomId).catch(() => undefined); },
      serverDeleted: (serverId) => { void workspace.refreshServersAfterDeletion(serverId).catch(() => undefined); },
      messageNew: (message) => { chat.applyNewMessage(message); notifyMessageRef.current(message); },
      messageUpdated: chat.applyUpdatedMessage,
      messageDeleted: chat.applyDeletedMessage,
      accessRevoked: workspace.revokeAccess
    }
  });
  const audio = useListenerAudio({
    socket: realtime.socket,
    user: session.user,
    iceServers: session.rtcConfig.iceServers,
    voiceRoomIds: workspace.voiceRoomIds,
    afkRoomIds: workspace.afkRoomIds,
    activeVoiceRoomRef,
    leaveVoiceRef,
    activeTextRoomIdRef: chat.activeTextRoomIdRef
  });

  const localVoiceSpeaking = Boolean(
    audio.voice.activeRoomId
      && audio.voice.voiceSnapshots[audio.voice.activeRoomId]?.members
        .find((member) => member.user.userId === session.user?.id)?.media.speaking
  );
  useIdlePresence({
    roomServerIdsRef,
    afkTimeoutsByServerRef: workspace.afkTimeoutsByServerRef,
    activeVoiceRoomId: audio.voice.activeRoomId,
    speaking: localVoiceSpeaking,
    reportStatus: (status) => realtime.socket?.emit("presence:setStatus", status)
  });

  // The move arrives as an instruction, not a state change, so it runs through
  // the same join the member would have performed themselves.
  useEffect(() => {
    moveVoiceRef.current = (roomId: string) => { void audio.voice.join(roomId, [], {}); };
  }, [audio.voice.join]);

  useEffect(() => {
    if (route.name === "voice") audio.voice.requestSnapshot(route.roomId);
  }, [route, audio.voice.requestSnapshot]);
  useEffect(() => { notifyMessageRef.current = audio.notifyMessage; }, [audio.notifyMessage]);

  const renderSurface = (surface: ReactNode) => session.user ? (
    <AuthenticatedAppSurface connectionHealth={audio.connectionHealth} t={t} audio={<>
      <GlobalVoiceAudio
        streams={audio.voice.remoteStreams}
        muted={audio.voice.controls.deafen.on || audio.voice.voiceModeration.deafened}
        mutedUserIds={new Set((audio.voice.activeRoomId ? audio.voice.voiceSnapshots[audio.voice.activeRoomId]?.members : [])?.filter((member) => member.moderation.muted).map((member) => member.user.userId) ?? [])}
        memberVolumes={audio.memberVolumes}
        outputVolume={audio.audioLevels.output}
      />
      {audio.microphoneTest.monitorStream ? <RemoteAudio stream={audio.microphoneTest.monitorStream} muted={false} volume={combineOutputVolume(DEFAULT_VOLUME_PERCENT, audio.audioLevels.output)} /> : null}
      {audio.audioPlaybackBlocked ? <AudioPlaybackRecovery t={t} /> : null}
    </>}>
      {surface}
    </AuthenticatedAppSurface>
  ) : surface;

  const user = session.user;
  const currentNickname = user
    ? workspace.serverMembers.find((member) => member.userId === user.id)?.nickname
      ?? workspace.onlineUsers.find((member) => member.userId === user.id)?.nickname
      ?? user.nickname
    : "";
  const shellProps = user ? {
    user,
    currentNickname,
    route,
    servers: workspace.servers,
    activeServerId: workspace.activeServerId,
    rooms: workspace.roomGroups,
    onlineUsers: workspace.onlineUsers,
    serverMembers: workspace.serverMembers,
    socketState: realtime.socketState,
    connectionHealth: audio.connectionHealth,
    activeVoiceRoomId: audio.voice.activeRoomId,
    controls: audio.voice.controls,
    voiceModeration: audio.voice.voiceModeration,
    micLockedByRoom: Boolean(audio.voice.activeRoomId && workspace.afkRoomIds.includes(audio.voice.activeRoomId)),
    appConfig: session.appConfig,
    voiceError: audio.voice.error || session.rtcConfigError,
    visualTargets: audio.voice.visualTargets,
    voiceSnapshots: audio.voice.voiceSnapshots,
    remoteStreams: audio.voice.remoteStreams,
    peerConnectionStates: audio.voice.peerConnectionStates,
    localPreviews: audio.voice.localPreviews,
    memberVolumes: audio.memberVolumes,
    screenVolumes: audio.screenVolumes,
    unreadByRoom: chat.unreadByRoom,
    roomHistory,
    pendingLiveWatch: audio.pendingLiveWatch,
    audioDevices: audio.audioDevices,
    audioLevels: audio.audioLevels,
    noiseSuppression: audio.noiseSuppression,
    noiseSuppressionSupported: audio.noiseSuppressionSupported,
    notificationSounds: audio.notificationSounds,
    microphoneTestActive: audio.microphoneTest.active,
    microphoneTestError: audio.microphoneTest.error,
    drawer,
    theme,
    language,
    t,
    currentRoom: workspace.currentRoom,
    onNavigate: navigate,
    onSelectServer: workspace.actions.selectServer,
    onCreateServer: workspace.actions.createServer,
    onUpdateServerName: workspace.actions.updateServerName,
    onSetAfkTimeout: workspace.actions.setAfkTimeout,
    onCreateRoom: workspace.actions.createRoom,
    onDeleteRoom: workspace.actions.deleteRoom,
    onDeleteServer: workspace.actions.deleteServer,
    onModerateMember: workspace.actions.moderateMember,
    onVoiceModeration: workspace.actions.voiceModeration,
    onUpdateMemberNickname: async (userId: string, nickname: string) => {
      const updated = await workspace.actions.updateMemberNickname(userId, nickname);
      chat.applyMemberRename(workspace.activeServerId, updated);
      return updated;
    },
    onUpdateMemberPermissions: workspace.actions.updateMemberPermissions,
    onDisconnectMember: workspace.actions.disconnectMember,
    onMoveMember: workspace.actions.moveMember,
    onDrawerChange: setDrawer,
    onThemeChange: changeTheme,
    onLanguageChange: changeLanguage,
    onJoinVoice: (roomId: string, options: VoiceJoinRequest = {}) => joinVoiceWithAudioUnlock(roomId, unlockSharedAudioOutput, releaseUnusedSharedAudioOutput, (nextRoomId) => audio.voice.join(nextRoomId, options.visualTargets ?? [], options)),
    onWatchLive: (request: LiveWatchRequest) => { audio.setPendingLiveWatch(request); navigate(serverPath(request.serverId, "voice", request.roomId)); },
    onLiveWatchHandled: () => audio.setPendingLiveWatch(null),
    onRequestVoiceSnapshot: audio.voice.requestSnapshot,
    onSetVisualSubscriptions: audio.voice.setVisualSubscriptions,
    onMemberVolumeChange: audio.changeMemberVolume,
    onScreenVolumeChange: audio.changeScreenVolume,
    onInputVolumeChange: (volume: number) => audio.changeAudioLevel("input", volume),
    onOutputVolumeChange: (volume: number) => audio.changeAudioLevel("output", volume),
    onNoiseSuppressionChange: audio.changeNoiseSuppression,
    onNotificationSoundsChange: audio.changeNotificationSounds,
    onToggleMicrophoneTest: audio.toggleMicrophoneTest,
    onCloseAudioSettings: () => { void audio.stopMicrophoneTest(); },
    onToggleControl: audio.voice.toggleControl,
    onLeaveVoice: audio.voice.leave,
    onLogout: async () => {
      audio.voice.leave();
      await logout();
      session.clearAuthentication();
      navigate("/invite");
    }
  } satisfies ShellModel & ShellActions : null;
  const textActions = route.name === "text" ? chat.actionsForRoom(route.roomId) : null;

  return <AppRoutes
    route={route}
    user={user}
    authState={session.authState}
    rtcConfigReady={session.rtcConfigReady}
    shellProps={shellProps}
    messages={route.name === "text" ? chat.messagesByRoom[route.roomId] ?? [] : []}
    language={language}
    t={t}
    renderSurface={renderSurface}
    turnstileSiteKey={session.appConfig.turnstile?.siteKey ?? null}
    analytics={session.appConfig.analytics}
    completeAuthentication={session.completeAuthentication}
    loadAcceptedServer={workspace.loadAcceptedServer}
    onOwnerClaimed={handleOwnerClaimed}
    onAccessClaimed={handleAccessClaimed}
    navigate={navigate}
    changeLanguage={changeLanguage}
    textRoomOutbox={route.name === "text" ? chat.outboxByRoom[route.roomId] ?? [] : []}
    textRoomActions={textActions}
  />;
}
