import type { PresenceUser,VoiceModerationState } from "@voxly/shared";
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


export function memberActionMenuHeight({ hasVolume, canRename, canDisconnect, canModerate, canVoiceModerate = false, canAssignRoles = false }: {
  hasVolume: boolean;
  canRename: boolean;
  canDisconnect: boolean;
  canModerate: boolean;
  canVoiceModerate?: boolean;
  canAssignRoles?: boolean;
}) {
  return 20 + (hasVolume ? 64 : 0) + (canRename ? 40 : 0) + (canAssignRoles ? 62 : 0) + (canVoiceModerate ? 80 : 0) + (canDisconnect ? 40 : 0) + (canModerate ? 80 : 0);
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
    canAssignRoles: Boolean(onToggleInviteRole)
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
