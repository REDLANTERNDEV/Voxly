import type { PresenceUser,RoomSummary } from "@voxly/shared";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../api.js";
import { serverPath } from "../../app/navigation.js";
import { activeServerRole,canInviteToActiveServer,initial,voiceMembersForRoom } from "../../app/presentation.js";
import type { MemberAction,ShellActions,ShellModel,Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CameraIcon,GearIcon,HeadsetIcon,MicIcon,PlusIcon,ScreenIcon } from "../../components/ui/Icons.js";
import { BrandLockup,NavLink } from "../../components/ui/Navigation.js";
import { canOwnerModeratePerson,canOwnerVoiceModerate } from "../../lib/memberDirectory.js";
import { voiceChannelActivation } from "../../lib/voiceChannelActivation.js";
import { sidebarVoiceStatusKeys,sidebarVoiceStatusLabelKeys } from "../../lib/voiceControls.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
import { ContextMenu } from "../ContextMenu.js";
import { LiveStreamPopover } from "../LiveStreamPopover.js";
import { ServerSwitcher } from "../ServerSwitcher.js";
import { InviteQuickAction } from "../../features/invites/InviteQuickAction.js";
import { MemberActionMenu,memberActionMenuHeight,openSidebarMenuFromPointer,SidebarMenuTrigger,type SidebarActionMenuController } from "./SidebarMenus.js";
type ChannelRailProps = Pick<ShellModel,
  "activeServerId" | "activeVoiceRoomId" | "appConfig" | "audioDevices" | "audioLevels" |
  "controls" | "currentNickname" | "language" | "memberVolumes" |
  "microphoneTestActive" | "microphoneTestError" | "noiseSuppression" |
  "noiseSuppressionSupported" | "notificationSounds" | "rooms" | "route" |
  "servers" | "socketState" | "t" | "theme" | "unreadByRoom" | "user" |
  "voiceModeration" | "voiceSnapshots" | "micLockedByRoom"
> & Pick<ShellActions,
  "onCloseAudioSettings" | "onCreateRoom" | "onDeleteRoom" |
  "onInputVolumeChange" | "onJoinVoice" | "onLanguageChange" |
  "onMemberVolumeChange" | "onNavigate" | "onNoiseSuppressionChange" |
  "onNotificationSoundsChange" | "onOutputVolumeChange" |
  "onSelectServer" | "onThemeChange" | "onToggleControl" | "onToggleMicrophoneTest" |
  "onUpdateMemberPermissions" | "onVoiceModeration" | "onWatchLive" | "onMoveMember"
> & {
  actionMenu: SidebarActionMenuController;
  onRequestNickname: (user: PresenceUser, returnFocus: HTMLButtonElement | null) => void;
  onRequestMemberAction: (user: PresenceUser, action: MemberAction, roomId?: string) => void;
  onOpenSettings: () => void;
};

export function ChannelRail(props: ChannelRailProps) {
  const canManageServer = activeServerRole(props) === "owner";
  const canInvite = canInviteToActiveServer(props);
  const activeServer = props.servers.find((server) => server.id === props.activeServerId);
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
      <div className="rail-head">
        <BrandLockup subtitle="" href={serverPath(props.activeServerId, "text", props.rooms.text[0]?.id ?? "general")} onNavigate={props.onNavigate} />
        {canInvite ? <InviteQuickAction
          serverId={props.activeServerId}
          serverName={activeServer?.name ?? "Voxly"}
          publicUrl={props.appConfig.publicUrl}
          t={props.t}
        /> : null}
      </div>
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
        <div className="rail-section-head"><span className="label">{props.t("room.textRooms")}</span>{canManageServer ? <ChannelCreateControl kind="text" onCreate={props.onCreateRoom} t={props.t} /> : null}</div>
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
        <div className="rail-section-head"><span className="label">{props.t("room.voiceRooms")}</span>{canManageServer ? <ChannelCreateControl kind="voice" onCreate={props.onCreateRoom} t={props.t} /> : null}</div>
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
                    // Your own name is yours. Somebody else's is the owner's.
                    const canRename = !isRemote
                      || (canManageServer && member.user.role === "member");
                    const canModerate = canOwnerVoiceModerate(activeServerRole(props), props.user.id, member.user);
                    const canVoiceModerate = canModerate;
                    const canModeratePerson = canOwnerModeratePerson(activeServerRole(props), props.user.id, member.user);
                    const canAssignRoles = canManageServer && member.user.role === "member" && !member.user.isBot;
                    const menuHeight = memberActionMenuHeight({
                      hasVolume: isRemote,
                      canRename,
                      canDisconnect: canModerate,
                      canModerate: canModeratePerson,
                      canVoiceModerate,
                      canAssignRoles,
                      canMove: canModeratePerson && props.rooms.voice.length > 1,
                      hasSelfControls: !isRemote && Boolean(props.activeVoiceRoomId)
                    });
                    // Own row: rename and the two self-silences. Remote row:
                    // volume, and whatever moderation the caller is allowed.
                    const hasActions = isRemote || canRename || canModerate || canAssignRoles || !isRemote;
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
                        {sidebarVoiceStatusKeys(member.media, member.moderation).map((status) => (
                          <span className={`voice-channel-status is-${status} is-self`} aria-label={props.t(sidebarVoiceStatusLabelKeys[status])} key={status}>
                            {status === "deafened" ? <HeadsetIcon off /> : status === "camera" ? <CameraIcon off={false} /> : <MicIcon off />}
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
                          canModerate={canModeratePerson}
                          moderation={canVoiceModerate ? member.moderation : undefined}
                          onVoiceModeration={canVoiceModerate ? (moderation) => { void props.onVoiceModeration(member.user.userId, moderation); } : undefined}
                          onToggleInviteRole={canAssignRoles ? (canInviteMember) => { void props.onUpdateMemberPermissions(member.user.userId, canInviteMember); } : undefined}
                          moveTargets={canModeratePerson ? props.rooms.voice.filter((target) => target.id !== room.id) : undefined}
                          onMove={canModeratePerson ? (targetRoomId) => props.onMoveMember(member.user.userId, targetRoomId) : undefined}
                          selfControls={!isRemote && props.activeVoiceRoomId ? {
                            mic: props.controls.mic.on,
                            deafen: props.controls.deafen.on,
                            // The dock's rules, restated here rather than
                            // guessed at: an owner's silence and the AFK
                            // channel's are not a member's to undo.
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
                          onRename={(returnFocus) => props.onRequestNickname(member.user, returnFocus)}
                          onRequestAction={(action) => props.onRequestMemberAction(member.user, action, room.id)}
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
      {/* The rail is the drawer a phone opens with "Rooms", and the dock's own
          settings button is hidden at that width — so this is the mobile way
          in. On a wide screen it sits below the channels, out of the way of
          the list people actually use. */}
      <button className="btn btn-ghost rail-settings" type="button" onClick={props.onOpenSettings}>
        <GearIcon />
        <span>{props.t("settings.open")}</span>
      </button>
      {deleteError ? <p className="error-text" aria-live="polite">{deleteError}</p> : null}
      {deleteTarget ? <ConfirmDialog cancelLabel={props.t("common.cancel")}
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
      {moveTarget ? <ConfirmDialog cancelLabel={props.t("common.cancel")}
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

export function ChannelDeleteControl({
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


export function ChannelCreateControl({ kind, onCreate, t }: { kind: "text" | "voice"; onCreate: (name: string, kind: "text" | "voice") => Promise<void>; t: Translate }) {
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
      <button className="channel-create-trigger" ref={triggerRef} type="button" onClick={open} aria-label={t(kind === "text" ? "channel.createText" : "channel.createVoice")} aria-expanded={isOpen}><PlusIcon /></button>
      {isOpen ? createPortal(<div className="channel-create-popover" ref={popoverRef} role="dialog" aria-label={t(kind === "text" ? "channel.createText" : "channel.createVoice")} style={position}>
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
          <label className="form-field"><span>{t(kind === "text" ? "channel.textName" : "channel.voiceName")}</span><input className="input" ref={inputRef} name={`${kind}ChannelName`} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={64} autoComplete="off" /></label>
          <div className="channel-create-actions"><button className="btn btn-ghost" type="button" onClick={close}>{t("common.cancel")}</button><button className="btn btn-primary" type="submit" disabled={isBusy}>{t(isBusy ? "channel.creating" : "channel.create")}</button></div>
        </form>
      </div>, document.body) : null}
    </>
  );
}
