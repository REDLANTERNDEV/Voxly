import type { PresenceUser, VoiceModerationState } from "@voxly/shared";
import { createContext, useContext, type ReactNode } from "react";
import { activeServerRole } from "../../app/presentation.js";
import type { MemberAction, ShellActions, ShellModel } from "../../app/types.js";
import { canOwnerModeratePerson, canOwnerVoiceModerate } from "../../lib/memberDirectory.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
import {
  MemberActionMenu,
  memberActionMenuHeight,
  openSidebarMenuFromPointer,
  type SidebarActionMenuController
} from "./SidebarMenus.js";

type StageActions = Pick<
  ShellModel,
  | "activeServerId"
  | "servers"
  | "user"
  | "rooms"
  | "memberVolumes"
  | "activeVoiceRoomId"
  | "controls"
  | "micLockedByRoom"
  | "voiceModeration"
  | "socketState"
  | "microphoneTestActive"
  | "t"
> &
  Pick<
    ShellActions,
    "onMemberVolumeChange" | "onVoiceModeration" | "onUpdateMemberPermissions" | "onMoveMember" | "onToggleControl"
  > & {
    actionMenu: SidebarActionMenuController;
    onRequestNickname(member: PresenceUser, returnFocus: HTMLButtonElement | null): void;
    onRequestMemberAction(member: PresenceUser, action: MemberAction, roomId: string): void;
  };

export const StageActionsContext = createContext<StageActions | null>(null);

export function StageMemberActions({
  member,
  roomId,
  moderation,
  children
}: {
  member: PresenceUser;
  roomId: string;
  moderation?: VoiceModerationState;
  children: ReactNode;
}) {
  const props = useContext(StageActionsContext);
  if (!props) return <>{children}</>;
  const role = activeServerRole(props);
  const isRemote = member.userId !== props.user.id;
  const canRename = !isRemote || (role === "owner" && member.role === "member");
  const canVoiceModerate = canOwnerVoiceModerate(role, props.user.id, member);
  const canModerate = canOwnerModeratePerson(role, props.user.id, member);
  const canAssignRoles = role === "owner" && member.role === "member" && !member.isBot;
  const selfControls =
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
      : undefined;
  const menuKey = `stage-member:${member.userId}`;
  const menuHeight = memberActionMenuHeight({
    hasVolume: isRemote,
    canRename,
    canDisconnect: canVoiceModerate,
    canModerate,
    canVoiceModerate,
    canAssignRoles,
    canMove: canModerate && props.rooms.voice.length > 1,
    hasSelfControls: Boolean(selfControls)
  });
  return (
    <div
      className="stage-member-actions"
      tabIndex={0}
      onContextMenu={(event) => openSidebarMenuFromPointer(event, props.actionMenu, menuKey, 220, menuHeight)}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        props.actionMenu.open({
          key: menuKey,
          x: rect.right - 220,
          y: rect.bottom,
          menuWidth: 220,
          menuHeight,
          trigger: null
        });
      }}
    >
      {children}
      <MemberActionMenu
        actionMenu={props.actionMenu}
        menuKey={menuKey}
        member={member}
        volume={isRemote ? (props.memberVolumes[member.userId] ?? DEFAULT_VOLUME_PERCENT) : undefined}
        onVolumeChange={isRemote ? (volume) => props.onMemberVolumeChange(member.userId, volume) : undefined}
        canRename={canRename}
        canDisconnect={canVoiceModerate}
        canModerate={canModerate}
        moderation={canVoiceModerate ? moderation : undefined}
        onVoiceModeration={
          canVoiceModerate
            ? (value) => {
                void props.onVoiceModeration(member.userId, value);
              }
            : undefined
        }
        onToggleInviteRole={
          canAssignRoles
            ? (value) => {
                void props.onUpdateMemberPermissions(member.userId, value);
              }
            : undefined
        }
        moveTargets={canModerate ? props.rooms.voice.filter((room) => room.id !== roomId) : undefined}
        onMove={canModerate ? (target) => props.onMoveMember(member.userId, target) : undefined}
        selfControls={selfControls}
        onRename={(focus) => props.onRequestNickname(member, focus)}
        onRequestAction={(action) => props.onRequestMemberAction(member, action, roomId)}
        t={props.t}
      />
    </div>
  );
}
