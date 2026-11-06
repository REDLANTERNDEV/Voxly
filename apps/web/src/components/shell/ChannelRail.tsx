import type { PresenceUser, RoomSummary } from "@voxly/shared";
import { useState, type ReactNode } from "react";
import { ApiError } from "../../api.js";
import { serverPath } from "../../app/navigation.js";
import {
  activeServerRole,
  canInviteToActiveServer,
  initial,
  memberRolesMenu,
  voiceMembersForRoom
} from "../../app/presentation.js";
import type { MemberAction, ShellActions, ShellModel, Translate } from "../../app/types.js";
import { ChannelNameDialog, ConfirmDialog } from "../../components/ui/Dialogs.js";
import {
  CameraIcon,
  ChevronIcon,
  GearIcon,
  HashIcon,
  LockIcon,
  HeadsetIcon,
  MicIcon,
  ScreenIcon,
  SpeakerIcon
} from "../../components/ui/Icons.js";
import { NavLink } from "../../components/ui/Navigation.js";
import { ChannelAccessDialog } from "../../features/owner/ChannelAccessDialog.js";
import { canMemberEnter, canOwnerModeratePerson, canOwnerVoiceModerate } from "../../lib/memberDirectory.js";
import { voiceChannelActivation } from "../../lib/voiceChannelActivation.js";
import { sidebarVoiceStatusKeys, sidebarVoiceStatusLabelKeys } from "../../lib/voiceControls.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
import { ContextMenu } from "../ContextMenu.js";
import { LiveStreamPopover } from "../LiveStreamPopover.js";
import { InviteQuickAction } from "../../features/invites/InviteQuickAction.js";
import {
  MemberActionMenu,
  memberActionMenuHeight,
  openSidebarMenuFromPointer,
  SidebarMenuTrigger,
  type SidebarActionMenuController
} from "./SidebarMenus.js";
import { ChannelOrganizer, type ChannelRoomActions } from "./ChannelOrganizer.js";
import { CallLength } from "./CallLength.js";
type ChannelRailProps = Pick<
  ShellModel,
  | "activeServerId"
  | "activeVoiceRoomId"
  | "appConfig"
  | "audioDevices"
  | "audioLevels"
  | "controls"
  | "currentNickname"
  | "language"
  | "memberVolumes"
  | "microphoneTestActive"
  | "microphoneTestError"
  | "noiseSuppression"
  | "noiseSuppressionSupported"
  | "notificationSounds"
  | "rooms"
  | "serverMembers"
  | "serverRoles"
  | "categories"
  | "uncategorizedPosition"
  | "route"
  | "servers"
  | "socketState"
  | "t"
  | "theme"
  | "unreadByRoom"
  | "user"
  | "voiceModeration"
  | "voiceSnapshots"
  | "callStarts"
  | "micLockedByRoom"
> &
  Pick<
    ShellActions,
    | "onCloseAudioSettings"
    | "onCreateRoom"
    | "onCreateCategory"
    | "onRenameCategory"
    | "onDeleteCategory"
    | "onSaveRoomLayout"
    | "onRenameRoom"
    | "onUpdateRoomAccess"
    | "onDeleteRoom"
    | "onInputVolumeChange"
    | "onJoinVoice"
    | "onLanguageChange"
    | "onMemberVolumeChange"
    | "onNavigate"
    | "onNoiseSuppressionChange"
    | "onNotificationSoundsChange"
    | "onOutputVolumeChange"
    | "onSelectServer"
    | "onThemeChange"
    | "onToggleControl"
    | "onToggleMicrophoneTest"
    | "onSetMemberRole"
    | "onVoiceModeration"
    | "onWatchLive"
    | "onMoveMember"
  > & {
    actionMenu: SidebarActionMenuController;
    onRequestNickname: (user: PresenceUser, returnFocus: HTMLButtonElement | null) => void;
    onRequestMemberAction: (user: PresenceUser, action: MemberAction, roomId?: string) => void;
    onOpenSettings: () => void;
    mobileStatus?: ReactNode;
  };

/**
 * A channel's name, and for a Private channel a muted lock that a screen
 * reader hears as words rather than missing.
 */
function ChannelLabel({ room, t }: { room: RoomSummary; t: ChannelRailProps["t"] }) {
  return (
    <span className="channel-label">
      <span className="channel-name">{room.name}</span>
      {room.isPrivate ? (
        <span className="channel-lock" title={t("channel.private")}>
          <LockIcon />
          <span className="sr-only">{t("channel.private")}</span>
        </span>
      ) : null}
    </span>
  );
}

export function ChannelRail(props: ChannelRailProps) {
  const canManageServer = activeServerRole(props) === "owner";
  const canInvite = canInviteToActiveServer(props);
  const activeServer = props.servers.find((server) => server.id === props.activeServerId);
  const [renameTarget, setRenameTarget] = useState<{ room: RoomSummary; trigger: HTMLButtonElement | null } | null>(
    null
  );
  const [deleteTarget, setDeleteTarget] = useState<RoomSummary | null>(null);
  const [accessTarget, setAccessTarget] = useState<{ room: RoomSummary; trigger: HTMLButtonElement | null } | null>(
    null
  );
  const [deleteError, setDeleteError] = useState("");
  const [moveTarget, setMoveTarget] = useState<RoomSummary | null>(null);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const activateVoiceRoom = (room: RoomSummary) => {
    // A Listed channel without access is seen, never entered (ADR-0037).
    if (props.socketState !== "live" || !room.canEnter) return;
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
    void props
      .onJoinVoice(room.id)
      .then((joined) => {
        if (joined) props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
      })
      .finally(() => setJoiningRoomId(null));
  };
  const categoryChoices = [
    { id: null, name: props.t("room.uncategorized") },
    ...props.categories.map((category) => ({ id: category.id, name: category.name }))
  ];
  const renderRoom = (room: RoomSummary, actions: ChannelRoomActions) => {
    const actionMenuHeight = channelActionMenuHeight();
    const actionControl = canManageServer ? (
      <ChannelDeleteControl
        actionMenu={props.actionMenu}
        room={room}
        categories={categoryChoices}
        actions={actions}
        disabled={props.rooms.text.length + props.rooms.voice.length <= 1}
        onRename={(trigger) => setRenameTarget({ room, trigger })}
        onAccess={(trigger) => setAccessTarget({ room, trigger })}
        onRequest={() => setDeleteTarget(room)}
        t={props.t}
      />
    ) : null;
    const rowData = {
      "data-drop-room": room.id,
      "data-drop-category-id": room.categoryId ?? "",
      "data-drag-kind": canManageServer ? "room" : undefined,
      "data-drag-id": canManageServer ? room.id : undefined
    };
    if (room.kind === "text") {
      return (
        <div
          className={`channel-row ${props.unreadByRoom[room.id] ? "is-unread" : ""}`}
          key={room.id}
          {...rowData}
          onContextMenu={
            canManageServer
              ? (event) =>
                  openSidebarMenuFromPointer(event, props.actionMenu, `channel:${room.id}`, 220, actionMenuHeight)
              : undefined
          }
        >
          <NavLink
            className={`channel-item ${props.route.name === "text" && props.route.roomId === room.id ? "is-active" : ""}`}
            href={serverPath(props.activeServerId, "text", room.id)}
            onNavigate={props.onNavigate}
          >
            <span className="channel-prefix" aria-hidden="true">
              <HashIcon />
            </span>
            <ChannelLabel room={room} t={props.t} />
            {props.unreadByRoom[room.id] ? (
              <span className="badge unread-badge">{props.unreadByRoom[room.id]}</span>
            ) : (
              <span />
            )}
          </NavLink>
          {actionControl}
        </div>
      );
    }

    const members = voiceMembersForRoom(props, room.id);
    const callStart = props.callStarts[room.id];
    // The server withholds a Listed channel's Call length from people who
    // cannot enter it; the rail does not show one it may still hold either.
    const showCallLength = callStart !== undefined && room.canEnter;
    const moveTargetsFor = (user: PresenceUser) =>
      props.rooms.voice.filter((target) => target.id !== room.id && canMemberEnter(target, user));
    return (
      <div className="voice-channel-block" key={room.id}>
        <div
          className="channel-row"
          {...rowData}
          onContextMenu={
            canManageServer
              ? (event) =>
                  openSidebarMenuFromPointer(event, props.actionMenu, `channel:${room.id}`, 220, actionMenuHeight)
              : undefined
          }
        >
          <NavLink
            className={`channel-item ${props.route.name === "voice" && props.route.roomId === room.id ? "is-active" : ""}`}
            href={serverPath(props.activeServerId, "voice", room.id)}
            onNavigate={props.onNavigate}
            // A Listed channel without access is seen, never entered
            // (ADR-0037): no join, no move, and no opening its stage.
            disabledReason={room.canEnter ? undefined : props.t("channel.noAccessVoice")}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
              event.preventDefault();
              if (joiningRoomId) return;
              activateVoiceRoom(room);
            }}
          >
            <span className={`channel-prefix ${showCallLength ? "is-calling" : ""}`} aria-hidden="true">
              <SpeakerIcon />
            </span>
            <ChannelLabel room={room} t={props.t} />
            {showCallLength ? <CallLength startedAt={callStart} t={props.t} /> : null}
          </NavLink>
          {actionControl}
        </div>
        {members.length > 0 ? (
          <div className="voice-channel-users">
            {members.map((member) => {
              const isRemote = member.user.userId !== props.user.id;
              // Your own name is yours. Somebody else's is the owner's.
              const canRename = !isRemote || (canManageServer && member.user.role === "member");
              const canModerate = canOwnerVoiceModerate(activeServerRole(props), props.user.id, member.user);
              const canVoiceModerate = canModerate;
              const canModeratePerson = canOwnerModeratePerson(activeServerRole(props), props.user.id, member.user);
              const roles = memberRolesMenu(props, member.user);
              const canAssignRoles = Boolean(roles);
              const menuHeight = memberActionMenuHeight({
                hasVolume: isRemote,
                canRename,
                canDisconnect: canModerate,
                canModerate: canModeratePerson,
                canVoiceModerate,
                canAssignRoles,
                canMove: canModeratePerson && moveTargetsFor(member.user).length > 0,
                hasSelfControls: !isRemote && Boolean(props.activeVoiceRoomId)
              });
              const hasActions = isRemote || canRename || canModerate || canAssignRoles || !isRemote;
              const menuKey = `rail-member:${member.user.userId}`;
              return (
                <div
                  className={`voice-channel-user ${props.activeVoiceRoomId === room.id && props.voiceSnapshots[room.id]?.viewerInVoiceRoom && member.media.speaking && member.media.mic && !member.media.deafened && !member.moderation.muted ? "is-speaking" : ""}`}
                  key={member.user.userId}
                  tabIndex={hasActions ? 0 : undefined}
                  onContextMenu={
                    hasActions
                      ? (event) => openSidebarMenuFromPointer(event, props.actionMenu, menuKey, 220, menuHeight)
                      : undefined
                  }
                  onKeyDown={
                    hasActions
                      ? (event) => {
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
                        }
                      : undefined
                  }
                >
                  <span className="avatar">{initial(member.user.nickname)}</span>
                  <span className="voice-channel-user-copy">
                    <span className="voice-channel-user-name">
                      {member.media.screen && room.canEnter ? (
                        <LiveStreamPopover
                          icon={<ScreenIcon off={false} />}
                          liveLabel={props.t("common.live")}
                          nickname={member.user.nickname}
                          watchLabel={props.t("voice.watchStream")}
                          watchAriaLabel={props.t("voice.watchUserStream", { nickname: member.user.nickname })}
                          onWatch={() =>
                            props.onWatchLive({
                              serverId: props.activeServerId,
                              roomId: room.id,
                              publisherUserId: member.user.userId,
                              nickname: member.user.nickname
                            })
                          }
                        />
                      ) : (
                        <span>{member.user.nickname}</span>
                      )}
                    </span>
                  </span>
                  <span className="voice-channel-statuses">
                    {member.moderation.deafened ? (
                      <span className="voice-channel-status is-enforced" aria-label={props.t("member.ownerDeafened")}>
                        <HeadsetIcon off />
                      </span>
                    ) : null}
                    {member.moderation.muted ? (
                      <span className="voice-channel-status is-enforced" aria-label={props.t("member.ownerMuted")}>
                        <MicIcon off />
                      </span>
                    ) : null}
                    {sidebarVoiceStatusKeys(member.media, member.moderation).map((status) => (
                      <span
                        className={`voice-channel-status is-${status} is-self`}
                        aria-label={props.t(sidebarVoiceStatusLabelKeys[status])}
                        key={status}
                      >
                        {status === "deafened" ? (
                          <HeadsetIcon off />
                        ) : status === "camera" ? (
                          <CameraIcon off={false} />
                        ) : (
                          <MicIcon off />
                        )}
                      </span>
                    ))}
                  </span>
                  {hasActions ? (
                    <MemberActionMenu
                      actionMenu={props.actionMenu}
                      menuKey={menuKey}
                      member={member.user}
                      volume={
                        isRemote ? (props.memberVolumes[member.user.userId] ?? DEFAULT_VOLUME_PERCENT) : undefined
                      }
                      onVolumeChange={
                        isRemote ? (volume) => props.onMemberVolumeChange(member.user.userId, volume) : undefined
                      }
                      canRename={canRename}
                      canDisconnect={canModerate}
                      canModerate={canModeratePerson}
                      moderation={canVoiceModerate ? member.moderation : undefined}
                      onVoiceModeration={
                        canVoiceModerate
                          ? (moderation) => {
                              void props.onVoiceModeration(member.user.userId, moderation);
                            }
                          : undefined
                      }
                      roles={roles}
                      moveTargets={canModeratePerson ? moveTargetsFor(member.user) : undefined}
                      onMove={
                        canModeratePerson
                          ? (targetRoomId) => props.onMoveMember(member.user.userId, targetRoomId)
                          : undefined
                      }
                      selfControls={
                        !isRemote && props.activeVoiceRoomId
                          ? {
                              mic: props.controls.mic.on,
                              deafen: props.controls.deafen.on,
                              micEnabled:
                                !props.micLockedByRoom &&
                                !props.voiceModeration.muted &&
                                props.controls.mic.enabled &&
                                props.socketState === "live",
                              deafenEnabled:
                                !props.voiceModeration.deafened &&
                                props.controls.deafen.enabled &&
                                !props.microphoneTestActive &&
                                props.socketState === "live",
                              onToggle: props.onToggleControl
                            }
                          : undefined
                      }
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
  };
  return (
    <aside
      className="rail"
      onContextMenu={
        canManageServer
          ? (event) => {
              if (event.defaultPrevented) return;
              const target = event.target as Element;
              if (
                target.closest(
                  "button, a, input, select, .rail-head, .server-switcher, [data-drop-room], [data-drop-category]"
                )
              )
                return;
              event.preventDefault();
              props.actionMenu.open({
                key: "channel-layout:background",
                x: event.clientX,
                y: event.clientY,
                menuWidth: 196,
                menuHeight: 88,
                trigger: null
              });
            }
          : undefined
      }
    >
      <div className="rail-head">
        <strong className="rail-server-name" title={activeServer?.name}>
          {activeServer?.name ?? "Voxly"}
        </strong>
        <button
          className="mobile-server-menu"
          type="button"
          aria-label={props.t("server.notificationMenu", { server: activeServer?.name ?? "Voxly" })}
          aria-haspopup="dialog"
          aria-expanded={props.actionMenu.active?.key === `server-notifications:${props.activeServerId}`}
          onClick={(event) => {
            const key = `server-notifications:${props.activeServerId}`;
            if (props.actionMenu.active?.key === key) {
              props.actionMenu.close();
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            props.actionMenu.open({
              key,
              x: rect.left,
              y: rect.bottom,
              menuWidth: 220,
              menuHeight: 100,
              trigger: event.currentTarget
            });
          }}
        >
          <span>{activeServer?.name ?? "Voxly"}</span>
          <ChevronIcon direction="down" />
        </button>
        {canInvite ? (
          <InviteQuickAction
            serverId={props.activeServerId}
            serverName={activeServer?.name ?? "Voxly"}
            publicUrl={props.appConfig.publicUrl}
            t={props.t}
          />
        ) : null}
      </div>
      <ChannelOrganizer
        serverId={props.activeServerId}
        categories={props.categories}
        uncategorizedPosition={props.uncategorizedPosition}
        rooms={[...props.rooms.text, ...props.rooms.voice]}
        canManage={canManageServer}
        actionMenu={props.actionMenu}
        t={props.t}
        onCreateCategory={props.onCreateCategory}
        onRenameCategory={props.onRenameCategory}
        onDeleteCategory={props.onDeleteCategory}
        onCreateRoom={props.onCreateRoom}
        onSaveLayout={props.onSaveRoomLayout}
        renderRoom={renderRoom}
      />
      {/* The rail is the drawer a phone opens with "Rooms", and the dock's own
          settings button is hidden at that width — so this is the mobile way
          in. On a wide screen it sits below the channels, out of the way of
          the list people actually use. */}
      <button className="btn btn-ghost rail-settings" type="button" onClick={props.onOpenSettings}>
        <GearIcon />
        <span>{props.t("settings.open")}</span>
      </button>
      {props.mobileStatus}
      {deleteError ? (
        <p className="error-text" aria-live="polite">
          {deleteError}
        </p>
      ) : null}
      {accessTarget ? (
        <ChannelAccessDialog
          key={accessTarget.room.id}
          room={accessTarget.room}
          members={props.serverMembers}
          lockedReason={
            accessTarget.room.isAfk
              ? props.t("channel.accessAfkLocked")
              : activeServer?.welcomeRoomId === accessTarget.room.id
                ? props.t("channel.accessWelcomeLocked")
                : null
          }
          returnFocus={accessTarget.trigger}
          t={props.t}
          onCancel={() => setAccessTarget(null)}
          onSave={(access) => props.onUpdateRoomAccess(accessTarget.room.id, access)}
        />
      ) : null}
      {renameTarget ? (
        <ChannelNameDialog
          key={renameTarget.room.id}
          name={renameTarget.room.name}
          returnFocus={renameTarget.trigger}
          t={props.t}
          onCancel={() => setRenameTarget(null)}
          onSave={(name) => props.onRenameRoom(renameTarget.room.id, name)}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          cancelLabel={props.t("common.cancel")}
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
        />
      ) : null}
      {moveTarget ? (
        <ConfirmDialog
          cancelLabel={props.t("common.cancel")}
          title={props.t("voice.moveTitle")}
          copy={props.t("voice.moveCopy", {
            current:
              props.rooms.voice.find((room) => room.id === props.activeVoiceRoomId)?.name ?? props.t("room.lobbyVoice"),
            target: moveTarget.name
          })}
          confirmLabel={props.t("voice.moveConfirm")}
          onCancel={() => setMoveTarget(null)}
          onConfirm={() => {
            const room = moveTarget;
            setMoveTarget(null);
            setJoiningRoomId(room.id);
            void props
              .onJoinVoice(room.id)
              .then((joined) => {
                if (joined) props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
              })
              .finally(() => setJoiningRoomId(null));
          }}
        />
      ) : null}
    </aside>
  );
}

/** Five 40px rows (Rename, Channel access, Move up, Move down, Delete), the category picker, and padding. */
function channelActionMenuHeight() {
  return 274;
}

export function ChannelDeleteControl({
  actionMenu,
  room,
  categories,
  actions,
  disabled,
  onRequest,
  onRename,
  onAccess,
  t
}: {
  actionMenu: SidebarActionMenuController;
  room: RoomSummary;
  categories: Array<{ id: string | null; name: string }>;
  actions: ChannelRoomActions;
  disabled: boolean;
  onRequest: () => void;
  onRename?: (trigger: HTMLButtonElement | null) => void;
  onAccess?: (trigger: HTMLButtonElement | null) => void;
  t: Translate;
}) {
  const menuKey = `channel:${room.id}`;
  const label = t("room.actionsFor", { channel: room.name });
  const menuHeight = channelActionMenuHeight();
  return (
    <>
      <SidebarMenuTrigger
        actionMenu={actionMenu}
        menuKey={menuKey}
        label={label}
        menuWidth={220}
        menuHeight={menuHeight}
      />
      {actionMenu.active?.key === menuKey ? (
        <ContextMenu descriptor={actionMenu.active} label={label} onClose={actionMenu.close}>
          {onRename ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const trigger = actionMenu.active?.trigger ?? null;
                actionMenu.close();
                onRename(trigger);
              }}
            >
              {t("channel.rename")}
            </button>
          ) : null}
          {onAccess ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const trigger = actionMenu.active?.trigger ?? null;
                actionMenu.close();
                onAccess(trigger);
              }}
            >
              {t("channel.access")}
            </button>
          ) : null}
          <label className="channel-move-menu-field">
            <span>{t("channel.moveTo")}</span>
            <select
              className="input"
              aria-label={t("channel.moveTo")}
              value={room.categoryId ?? ""}
              onChange={(event) => {
                const categoryId = event.currentTarget.value || null;
                actionMenu.close();
                if (categoryId !== room.categoryId) actions.moveTo(categoryId);
              }}
            >
              {categories.map((category) => (
                <option value={category.id ?? ""} key={category.id ?? "uncategorized"}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            role="menuitem"
            disabled={!actions.canMoveUp}
            onClick={() => {
              actionMenu.close();
              actions.moveUp();
            }}
          >
            {t("channel.moveUp")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!actions.canMoveDown}
            onClick={() => {
              actionMenu.close();
              actions.moveDown();
            }}
          >
            {t("channel.moveDown")}
          </button>
          <button
            className="is-danger"
            type="button"
            disabled={disabled}
            onClick={() => {
              actionMenu.close();
              onRequest();
            }}
          >
            {t("room.deleteChannel")}
          </button>
        </ContextMenu>
      ) : null}
    </>
  );
}
