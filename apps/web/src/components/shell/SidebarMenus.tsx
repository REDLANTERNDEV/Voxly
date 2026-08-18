import type { PresenceUser,RoomSummary,VoiceModerationState } from "@voxly/shared";
import type { MouseEvent } from "react";
import { useRef } from "react";
import type { MemberAction,Translate } from "../../app/types.js";
import { MoreIcon } from "../../components/ui/Icons.js";
import { VolumeControl } from "../../components/ui/Primitives.js";
import { type ContextMenuDescriptor } from "../../lib/contextMenu.js";
import { ContextMenu } from "../ContextMenu.js";
export interface SidebarActionMenuController {
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

export function SidebarMenuTrigger({
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

export function openSidebarMenuFromPointer(
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


export function memberActionMenuHeight({ hasVolume, canRename, canDisconnect, canModerate, canVoiceModerate = false, canAssignRoles = false, canMove = false }: {
  hasVolume: boolean;
  canRename: boolean;
  canDisconnect: boolean;
  canModerate: boolean;
  canVoiceModerate?: boolean;
  canAssignRoles?: boolean;
  canMove?: boolean;
}) {
  return 20 + (hasVolume ? 64 : 0) + (canRename ? 40 : 0) + (canAssignRoles ? 62 : 0) + (canVoiceModerate ? 80 : 0) + (canMove ? 40 : 0) + (canDisconnect ? 40 : 0) + (canModerate ? 80 : 0);
}

export function MemberActionMenu({
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
  onToggleInviteRole,
  moveTargets,
  onMove,
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
  onToggleInviteRole?: (canInvite: boolean) => void;
  /** Voice rooms this member may be moved to; empty hides the entry. */
  moveTargets?: RoomSummary[];
  onMove?: (roomId: string) => void;
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
    canVoiceModerate: Boolean(moderation && onVoiceModeration),
    canAssignRoles: Boolean(onToggleInviteRole),
    canMove: Boolean(onMove && moveTargets && moveTargets.length > 0)
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
          {onToggleInviteRole ? (
            <button
              className={member.canInvite ? "is-active" : ""}
              type="button"
              aria-pressed={Boolean(member.canInvite)}
              onClick={() => onToggleInviteRole(!member.canInvite)}
            >
              {member.canInvite ? t("member.revokeInviteRole") : t("member.grantInviteRole")}
            </button>
          ) : null}
          {moderation && onVoiceModeration ? <>
            <button className={moderation.muted ? "is-danger" : ""} type="button" aria-pressed={moderation.muted} onClick={() => onVoiceModeration({ muted: !moderation.muted })}>{moderation.muted ? t("member.ownerUnmute") : t("member.ownerMute")}</button>
            <button className={moderation.deafened ? "is-danger" : ""} type="button" aria-pressed={moderation.deafened} onClick={() => onVoiceModeration({ deafened: !moderation.deafened })}>{moderation.deafened ? t("member.ownerUndeafen") : t("member.ownerDeafen")}</button>
          </> : null}
          {onMove && moveTargets && moveTargets.length > 0 ? (
            <MemberMoveSubmenu
              label={t("member.moveTo")}
              rooms={moveTargets}
              onSelect={(roomId) => {
                actionMenu.close();
                onMove(roomId);
              }}
            />
          ) : null}
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

/**
 * A flyout of voice rooms, opened by hovering or focusing the row it hangs off.
 *
 * It is not a nested portal menu: the parent is already viewport-clamped, and a
 * second layer of clamping against a moving anchor is a great deal of machinery
 * for one list. Anchoring it to the row instead keeps it correct while the
 * parent menu moves, and CSS flips it to the other side when it would overflow.
 */
export function MemberMoveSubmenu({ label, rooms, onSelect }: {
  label: string;
  rooms: RoomSummary[];
  onSelect: (roomId: string) => void;
}) {
  return (
    <div className="menu-submenu">
      <button type="button" className="menu-submenu-trigger" aria-haspopup="menu" aria-expanded={undefined}>
        <span>{label}</span>
        <span className="menu-submenu-caret" aria-hidden="true">›</span>
      </button>
      <div className="menu-submenu-panel" role="menu" aria-label={label}>
        {rooms.map((room) => (
          <button key={room.id} role="menuitem" type="button" onClick={() => onSelect(room.id)}>
            {room.name}
          </button>
        ))}
      </div>
    </div>
  );
}
