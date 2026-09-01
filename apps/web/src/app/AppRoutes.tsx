import type { ChatMessage,ChatMessageReply,PublicUser } from "@voxly/shared";
import type { ReactNode } from "react";
import { AppShellSkeleton } from "../components/AppShellSkeleton.js";
import { AppChrome } from "../components/shell/AppChrome.js";
import { FatalState } from "../components/ui/Primitives.js";
import { InviteRequiredScreen,LandingPage } from "../features/auth/AuthScreens.js";
import { AccessClaimScreen,OwnerClaimScreen } from "../features/auth/ClaimScreens.js";
import { InviteScreen } from "../features/auth/InviteScreen.js";
import { LinkDeviceScreen } from "../features/auth/LinkDeviceScreen.js";
import { RecoverScreen } from "../features/auth/RecoverScreen.js";
import { TextRoomScreen } from "../features/chat/TextRoomScreen.js";
import { OwnerPanel } from "../features/owner/OwnerPanel.js";
import { VoiceRoomScreen } from "../features/voice/VoiceRoomScreen.js";
import type { AnalyticsSettings } from "../lib/analytics.js";
import type { LanguageCode } from "../lib/i18n.js";
import type { OutboxEntry } from "../lib/messageOutbox.js";
import { resolveInitialRoute } from "../lib/navigation.js";
import { startupSurface } from "../lib/startupSurface.js";
import type { LoadState,Route,ShellActions,ShellModel,Translate } from "./types.js";

export function AppRoutes({ route, user, authState, rtcConfigReady, shellProps, messages, language, t, renderSurface, turnstileSiteKey, analytics, signedOutReason, completeAuthentication, loadAcceptedServer, onOwnerClaimed, onAccessClaimed, navigate, changeLanguage, textRoomOutbox, textRoomActions }: {
  route: Route;
  user: PublicUser | null;
  authState: LoadState;
  rtcConfigReady: boolean;
  shellProps: (ShellModel & ShellActions) | null;
  messages: ChatMessage[];
  language: LanguageCode;
  t: Translate;
  renderSurface(surface: ReactNode): ReactNode;
  turnstileSiteKey: string | null;
  analytics: AnalyticsSettings | null;
  /** Why the member is here rather than in the app, when it is worth saying. */
  signedOutReason: "" | "reused" | "revoked";
  completeAuthentication(user: PublicUser): void;
  loadAcceptedServer(serverId: string): Promise<void>;
  onOwnerClaimed(user: PublicUser): void;
  onAccessClaimed(user: PublicUser, serverId: string): void;
  navigate(path: string): void;
  changeLanguage(language: LanguageCode): void;
  textRoomOutbox: OutboxEntry[];
  textRoomActions: { send(body: string, replyTo: ChatMessageReply | null): void; retrySend(localId: string): void; discardSend(localId: string): void; update(messageId: string, body: string): Promise<void>; delete(messageId: string): Promise<void>; suppressEmbed(messageId: string, embedKey: string): Promise<void> } | null;
}) {
  if (startupSurface(route.name, authState) === "shell-skeleton") return renderSurface(<AppShellSkeleton t={t} />);
  if (user && !rtcConfigReady && (route.name === "text" || route.name === "voice" || route.name === "owner")) return renderSurface(<AppShellSkeleton t={t} />);
  if (authState === "error" && (route.name === "text" || route.name === "voice" || route.name === "owner")) return renderSurface(<FatalState t={t} />);
  if (route.name === "owner-claim") {
    return renderSurface(<OwnerClaimScreen token={route.token} language={language} t={t} onLanguageChange={changeLanguage} onClaimed={onOwnerClaimed} />);
  }
  // Before the signed-out fallback below, which otherwise sends every
  // sessionless route to the invite screen. A member arriving here already has
  // an account; they are proving it from a new Device.
  if (route.name === "link-device") {
    // A full load rather than a client navigation. The session cookie was set
    // by the request that just succeeded, but this app already asked
    // `/api/me` at startup and was told nobody was signed in — so navigating
    // in-place lands on the signed-out landing page and the member has to
    // refresh by hand before Voxly notices them. Reloading straight into the
    // app is what "I linked my phone and it just worked" requires.
    return renderSurface(<LinkDeviceScreen
      t={t}
      turnstileSiteKey={turnstileSiteKey}
      onLinked={() => window.location.assign(resolveInitialRoute({ isAuthenticated: true, inviteToken: null }))}
    />);
  }
  if (route.name === "recover") {
    // A full reload rather than a client navigation: recovery revoked every
    // other session, and the shell must be rebuilt around the new one rather
    // than carrying state that belonged to a session which no longer exists.
    return renderSurface(<RecoverScreen t={t} turnstileSiteKey={turnstileSiteKey} onRecovered={() => window.location.assign(resolveInitialRoute({ isAuthenticated: true, inviteToken: null }))} />);
  }
  if (route.name === "access-claim") {
    return renderSurface(<AccessClaimScreen token={route.token} t={t} onNavigate={navigate} onClaimed={onAccessClaimed} />);
  }
  if (!user && route.name === "landing") return <LandingPage language={language} analytics={analytics} signedOutReason={signedOutReason} t={t} onNavigate={navigate} onLanguageChange={changeLanguage} />;
  if (!user && route.name === "invite" && !route.token) return <InviteRequiredScreen language={language} t={t} onNavigate={navigate} onLanguageChange={changeLanguage} />;
  if (!user || route.name === "invite") {
    return renderSurface(<InviteScreen
      initialToken={route.name === "invite" ? route.token : ""}
      existingUser={Boolean(user)}
      currentUser={user}
      turnstileSiteKey={turnstileSiteKey}
      language={language}
      t={t}
      onLanguageChange={changeLanguage}
      onAccepted={(accepted, serverId) => {
        completeAuthentication(accepted);
        void loadAcceptedServer(serverId).catch(() => navigate("/"));
      }}
    />);
  }
  if (!shellProps) return renderSurface(<AppShellSkeleton t={t} />);
  if (route.name === "owner" && shellProps.servers.find((server) => server.id === route.serverId)?.role !== "owner") return renderSurface(<AppShellSkeleton t={t} />);
  if (route.name === "owner") return renderSurface(<OwnerPanel
    user={shellProps.user}
    currentNickname={shellProps.currentNickname}
    servers={shellProps.servers}
    activeServerId={shellProps.activeServerId}
    rooms={shellProps.rooms}
    appConfig={shellProps.appConfig}
    roomHistory={shellProps.roomHistory}
    language={shellProps.language}
    t={shellProps.t}
    onNavigate={shellProps.onNavigate}
    onCreateServer={shellProps.onCreateServer}
    onUpdateServerName={shellProps.onUpdateServerName}
    onSetAfkTimeout={shellProps.onSetAfkTimeout}
    onDeleteServer={shellProps.onDeleteServer}
    onModerateMember={shellProps.onModerateMember}
    onVoiceModeration={shellProps.onVoiceModeration}
    onUpdateMemberNickname={shellProps.onUpdateMemberNickname}
    onUpdateMemberPermissions={shellProps.onUpdateMemberPermissions}
  />);
  if (route.name === "voice") return renderSurface(<AppChrome {...shellProps} mobileTitle={shellProps.currentRoom?.name ?? t("room.lobbyVoice")}><VoiceRoomScreen
    user={shellProps.user}
    currentNickname={shellProps.currentNickname}
    route={shellProps.route}
    activeServerId={shellProps.activeServerId}
    rooms={shellProps.rooms}
    socketState={shellProps.socketState}
    activeVoiceRoomId={shellProps.activeVoiceRoomId}
    controls={shellProps.controls}
    visualTargets={shellProps.visualTargets}
    voiceSnapshots={shellProps.voiceSnapshots}
    musicQueues={shellProps.musicQueues}
    remoteStreams={shellProps.remoteStreams}
    peerConnectionStates={shellProps.peerConnectionStates}
    localPreviews={shellProps.localPreviews}
    memberVolumes={shellProps.memberVolumes}
    screenVolumes={shellProps.screenVolumes}
    roomHistory={shellProps.roomHistory}
    pendingLiveWatch={shellProps.pendingLiveWatch}
    audioLevels={shellProps.audioLevels}
    t={shellProps.t}
    currentRoom={shellProps.currentRoom}
    onNavigate={shellProps.onNavigate}
    onJoinVoice={shellProps.onJoinVoice}
    onWatchLive={shellProps.onWatchLive}
    onLiveWatchHandled={shellProps.onLiveWatchHandled}
    onRequestVoiceSnapshot={shellProps.onRequestVoiceSnapshot}
    onSetVisualSubscriptions={shellProps.onSetVisualSubscriptions}
    onMusicControl={shellProps.onMusicControl}
    onMemberVolumeChange={shellProps.onMemberVolumeChange}
    onScreenVolumeChange={shellProps.onScreenVolumeChange}
  /></AppChrome>);
  if (route.name !== "text" || !textRoomActions) return renderSurface(<AppShellSkeleton t={t} />);
  return renderSurface(<AppChrome {...shellProps} mobileTitle={shellProps.currentRoom?.name ?? shellProps.t("room.textRoom")}>
    <TextRoomScreen
      user={shellProps.user}
      language={shellProps.language}
      t={shellProps.t}
      currentRoom={shellProps.currentRoom}
      rooms={shellProps.rooms}
      roomHistory={shellProps.roomHistory}
      activeServerId={shellProps.activeServerId}
      onNavigate={shellProps.onNavigate}
      messages={messages}
      outbox={textRoomOutbox}
      onSendMessage={textRoomActions.send}
      onRetrySend={textRoomActions.retrySend}
      onDiscardSend={textRoomActions.discardSend}
      onUpdateMessage={textRoomActions.update}
      onDeleteMessage={textRoomActions.delete}
      onSuppressEmbed={textRoomActions.suppressEmbed}
    />
  </AppChrome>);
}
