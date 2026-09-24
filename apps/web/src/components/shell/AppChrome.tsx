import type { PresenceUser } from "@voxly/shared";
import type { ReactNode } from "react";
import { useCallback,useEffect,useMemo,useReducer,useRef,useState } from "react";
import { serverPath } from "../../app/navigation.js";
import { activeServerRole } from "../../app/presentation.js";
import type { MemberAction,ShellActions,ShellModel } from "../../app/types.js";
import { ConfirmDialog,NicknameDialog } from "../../components/ui/Dialogs.js";
import { MenuIcon,UsersIcon } from "../../components/ui/Icons.js";
import { BrandLockup } from "../../components/ui/Navigation.js";
import { NotificationViewport,useNotificationCenter } from "../../components/ui/Notifications.js";
import type { AppNotification } from "../../lib/notifications.js";
import { contextMenuReducer,createContextMenuDescriptor } from "../../lib/contextMenu.js";
import { type TranslationKey } from "../../lib/i18n.js";
import { countPeople } from "../../lib/memberDirectory.js";
import { settingsRequestEvent,type RequestedSettingsSection } from "../../lib/settingsNavigation.js";
import { ChannelRail } from "./ChannelRail.js";
import { MemberPanel } from "./MemberPanel.js";
import { SettingsDialog,type SettingsSection } from "./SettingsDialog.js";
import type { SidebarActionMenuController } from "./SidebarMenus.js";
import { VoiceDock } from "./VoiceDock.js";
export function AppChrome(props: ShellModel & ShellActions & { children: ReactNode; mobileTitle: string }) {
  const canModerate = activeServerRole(props) === "owner";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  const [settingsContextError, setSettingsContextError] = useState<TranslationKey | "">("");
  const [nicknameTarget, setNicknameTarget] = useState<{ user: PresenceUser; returnFocus: HTMLButtonElement | null } | null>(null);
  const [pendingMemberAction, setPendingMemberAction] = useState<{ user: PresenceUser; roomId?: string; action: MemberAction } | null>(null);
  const [activeActionMenu, dispatchActionMenu] = useReducer(contextMenuReducer, null);
  const notifications = useNotificationCenter();
  const deletionRequestRevisionRef = useRef(props.deletionRequestRevision);
  const closeActionMenu = useCallback(() => dispatchActionMenu({ type: "close" }), []);
  const openSettings = useCallback((section: SettingsSection = "account", contextError: TranslationKey | "" = "") => {
    setSettingsSection(section);
    setSettingsContextError(contextError);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    props.onCloseAudioSettings();
    setSettingsOpen(false);
    setSettingsContextError("");
  }, [props.onCloseAudioSettings]);
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
  const onlineCount = countPeople(props.onlineUsers) || 1;
  const voiceConnectedCount = props.activeVoiceRoomId && props.voiceSnapshots[props.activeVoiceRoomId]
    ? props.voiceSnapshots[props.activeVoiceRoomId].members.length
    : props.activeVoiceRoomId
      ? 1
      : 0;

  useEffect(() => {
    closeActionMenu();
  }, [closeActionMenu, props.activeServerId, props.currentRoom?.id, props.drawer, props.route.name]);

  useEffect(() => {
    const handleSettingsRequest = (event: Event) => openSettings((event as CustomEvent<RequestedSettingsSection>).detail);
    window.addEventListener(settingsRequestEvent, handleSettingsRequest);
    return () => window.removeEventListener(settingsRequestEvent, handleSettingsRequest);
  }, [openSettings]);

  useEffect(() => {
    if (!props.voiceError) return;
    notifications.push({
      id: `voice-error:${props.voiceError}`,
      tone: "danger",
      titleKey: "notification.voiceErrorTitle",
      messageKey: props.voiceError,
      timeoutMs: null,
      action: props.voiceError === "voiceError.microphoneDisconnected" ? undefined : "open-audio-settings"
    });
  }, [notifications.push, props.voiceError, props.voiceErrorRevision]);

  useEffect(() => {
    if (!props.voiceNotice) return;
    notifications.push({
      id: `voice-notice:${props.voiceNotice}`,
      tone: "neutral",
      titleKey: "notification.voiceNoticeTitle",
      messageKey: props.voiceNotice,
      timeoutMs: 5_200
    });
  }, [notifications.push, props.voiceNotice, props.voiceNoticeRevision]);

  useEffect(() => {
    if (props.deletionRequestRevision === deletionRequestRevisionRef.current) return;
    deletionRequestRevisionRef.current = props.deletionRequestRevision;
    notifications.push({
      id: `account-deletion-request:${props.deletionRequestRevision}`,
      tone: "danger",
      titleKey: "notification.accountDeletionRequestTitle",
      messageKey: "notification.accountDeletionRequestCopy",
      timeoutMs: null
    });
  }, [notifications.push, props.deletionRequestRevision]);

  const handleNotificationAction = useCallback((item: AppNotification) => {
    if (item.action === "open-audio-settings") openSettings("audio", item.messageKey);
  }, [openSettings]);

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
          onOpenSettings={() => openSettings()}
          onToggleControl={props.onToggleControl}
          micLockedByRoom={props.micLockedByRoom}
          activeServerId={props.activeServerId}
          activeVoiceRoomId={props.activeVoiceRoomId}
          appConfig={props.appConfig}
          audioDevices={props.audioDevices}
          audioLevels={props.audioLevels}
          controls={props.controls}
          currentNickname={props.currentNickname}
          language={props.language}
          memberVolumes={props.memberVolumes}
          microphoneTestActive={props.microphoneTestActive}
          microphoneTestError={props.microphoneTestError}
          noiseSuppression={props.noiseSuppression}
          noiseSuppressionSupported={props.noiseSuppressionSupported}
          notificationSounds={props.notificationSounds}
          rooms={props.rooms}
          categories={props.categories}
          uncategorizedPosition={props.uncategorizedPosition}
          route={props.route}
          servers={props.servers}
          socketState={props.socketState}
          t={props.t}
          theme={props.theme}
          unreadByRoom={props.unreadByRoom}
          user={props.user}
          voiceModeration={props.voiceModeration}
          voiceSnapshots={props.voiceSnapshots}
          onCloseAudioSettings={props.onCloseAudioSettings}
          onCreateRoom={props.onCreateRoom}
          onCreateCategory={props.onCreateCategory}
          onRenameCategory={props.onRenameCategory}
          onDeleteCategory={props.onDeleteCategory}
          onSaveRoomLayout={props.onSaveRoomLayout}
          onDeleteRoom={props.onDeleteRoom}
          onInputVolumeChange={props.onInputVolumeChange}
          onJoinVoice={props.onJoinVoice}
          onLanguageChange={props.onLanguageChange}
          onMemberVolumeChange={props.onMemberVolumeChange}
          onNavigate={props.onNavigate}
          onNoiseSuppressionChange={props.onNoiseSuppressionChange}
          onNotificationSoundsChange={props.onNotificationSoundsChange}
          onOutputVolumeChange={props.onOutputVolumeChange}
          onSelectServer={props.onSelectServer}
          onThemeChange={props.onThemeChange}
          onToggleMicrophoneTest={props.onToggleMicrophoneTest}
          onUpdateMemberPermissions={props.onUpdateMemberPermissions}
          onMoveMember={props.onMoveMember}
          onVoiceModeration={props.onVoiceModeration}
          onWatchLive={props.onWatchLive}
          actionMenu={actionMenu}
          onRequestNickname={(member, returnFocus) => setNicknameTarget({ user: member, returnFocus })}
          onRequestMemberAction={(member, action, roomId) => {
            closeActionMenu();
            setPendingMemberAction({ user: member, action, roomId });
          }}
        />
        {props.children}
        <MemberPanel
          selfVoice={props.activeVoiceRoomId ? {
            mic: props.controls.mic.on,
            deafen: props.controls.deafen.on,
            micEnabled: !props.micLockedByRoom
              && !props.voiceModeration.muted
              && props.controls.mic.enabled
              && props.socketState === "live",
            deafenEnabled: !props.voiceModeration.deafened
              && props.controls.deafen.enabled
              && !props.microphoneTestActive
              && props.socketState === "live",
            onToggle: props.onToggleControl
          } : undefined}
          members={props.serverMembers}
          onlineUsers={props.onlineUsers}
          voiceRooms={props.rooms.voice}
          voiceSnapshots={props.voiceSnapshots}
          currentUser={props.user}
          canModerate={canModerate}
          memberVolumes={props.memberVolumes}
          onMemberVolumeChange={props.onMemberVolumeChange}
          onVoiceModeration={props.onVoiceModeration}
          onUpdateMemberPermissions={props.onUpdateMemberPermissions}
          onMoveMember={props.onMoveMember}
          onRequestNickname={(member, returnFocus) => setNicknameTarget({ user: member, returnFocus })}
          onRequestMemberAction={(member, action, roomId) => {
            closeActionMenu();
            setPendingMemberAction({ user: member, action, roomId });
          }}
          actionMenu={actionMenu}
          t={props.t}
        />
      </div>
      <VoiceDock
        activeServerId={props.activeServerId}
        activeVoiceRoomId={props.activeVoiceRoomId}
        connectionHealth={props.connectionHealth}
        voiceQuality={props.voiceQuality}
        onOpenSettings={() => openSettings()}
        controls={props.controls}
        currentNickname={props.currentNickname}
        currentRoom={props.currentRoom}
        microphoneTestActive={props.microphoneTestActive}
        route={props.route}
        servers={props.servers}
        socketState={props.socketState}
        t={props.t}
        user={props.user}
        voiceModeration={props.voiceModeration}
        micLockedByRoom={props.micLockedByRoom}
        onJoinVoice={props.onJoinVoice}
        onLeaveVoice={props.onLeaveVoice}
        onLogout={props.onLogout}
        onNavigate={props.onNavigate}
        onToggleControl={props.onToggleControl}
        connectedCount={voiceConnectedCount}
      />
      <NotificationViewport
        items={notifications.notifications}
        suspended={settingsOpen}
        t={props.t}
        onDismiss={notifications.dismiss}
        onExpire={notifications.expire}
        onAction={handleNotificationAction}
      />
      {settingsOpen ? <SettingsDialog {...props} initialSection={settingsSection} contextError={settingsContextError} onClose={closeSettings} /> : null}
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
      {pendingMemberAction ? <ConfirmDialog cancelLabel={props.t("common.cancel")}
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
