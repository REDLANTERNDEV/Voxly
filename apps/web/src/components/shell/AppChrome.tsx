import type { PresenceUser } from "@voxly/shared";
import type { ReactNode } from "react";
import { useCallback,useEffect,useMemo,useReducer,useState } from "react";
import { serverPath } from "../../app/navigation.js";
import { activeServerRole } from "../../app/presentation.js";
import type { MemberAction,ShellActions,ShellModel } from "../../app/types.js";
import { ConfirmDialog,NicknameDialog } from "../../components/ui/Dialogs.js";
import { MenuIcon,UsersIcon } from "../../components/ui/Icons.js";
import { BrandLockup } from "../../components/ui/Navigation.js";
import { Toast } from "../../components/ui/Primitives.js";
import { contextMenuReducer,createContextMenuDescriptor } from "../../lib/contextMenu.js";
import { type TranslationKey } from "../../lib/i18n.js";
import { ChannelRail } from "./ChannelRail.js";
import { MemberPanel } from "./MemberPanel.js";
import type { SidebarActionMenuController } from "./SidebarMenus.js";
import { VoiceDock } from "./VoiceDock.js";
export function AppChrome(props: ShellModel & ShellActions & { children: ReactNode; mobileTitle: string }) {
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
          rooms={props.rooms}
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
          onDeleteRoom={props.onDeleteRoom}
          onInputVolumeChange={props.onInputVolumeChange}
          onJoinVoice={props.onJoinVoice}
          onLanguageChange={props.onLanguageChange}
          onMemberVolumeChange={props.onMemberVolumeChange}
          onNavigate={props.onNavigate}
          onNoiseSuppressionChange={props.onNoiseSuppressionChange}
          onOutputVolumeChange={props.onOutputVolumeChange}
          onSelectServer={props.onSelectServer}
          onThemeChange={props.onThemeChange}
          onToggleMicrophoneTest={props.onToggleMicrophoneTest}
          onUpdateMemberPermissions={props.onUpdateMemberPermissions}
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
        onJoinVoice={props.onJoinVoice}
        onLeaveVoice={props.onLeaveVoice}
        onLogout={props.onLogout}
        onNavigate={props.onNavigate}
        onToggleControl={props.onToggleControl}
        connectedCount={voiceConnectedCount}
      />
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
