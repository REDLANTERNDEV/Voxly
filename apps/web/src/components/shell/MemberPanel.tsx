import type { PresenceUser,PublicUser,RoomSummary,VoiceModerationState,VoiceSnapshot } from "@voxly/shared";
import { initial,memberRoleLabel } from "../../app/presentation.js";
import type { MemberAction,Translate } from "../../app/types.js";
import { UserPlusIcon } from "../ui/Icons.js";
import { canOwnerVoiceModerate,currentServerPresence,groupDirectoryMembers } from "../../lib/memberDirectory.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
import { MemberActionMenu,memberActionMenuHeight,openSidebarMenuFromPointer,type SidebarActionMenuController } from "./SidebarMenus.js";
export function MemberPanel({
  members,
  onlineUsers,
  voiceRooms,
  voiceSnapshots,
  currentUser,
  canModerate,
  memberVolumes,
  onMemberVolumeChange,
  onVoiceModeration,
  onUpdateMemberPermissions,
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
  onUpdateMemberPermissions: (userId: string, canInvite: boolean) => Promise<PresenceUser>;
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
  const groupedMembers = groupDirectoryMembers(members, onlineUsers, currentServerPresence(currentUser, members));
  const renderMembers = (users: PresenceUser[], online: boolean) => users.map((user) => {
    const voiceRoom = roomByMemberId.get(user.userId);
    const voiceMember = voiceRoom ? voiceSnapshots[voiceRoom.id]?.members.find((member) => member.user.userId === user.userId) : undefined;
    const roleLabel = memberRoleLabel(user, t);
    const detail = voiceRoom ? `${roleLabel} · ${voiceRoom.name}` : roleLabel;
    const canRename = canModerate && (user.role === "member" || user.userId === currentUser.id);
    const canModerateRemote = canOwnerVoiceModerate(canModerate ? "owner" : null, currentUser.id, user);
    const canAssignRoles = canModerate && user.role === "member";
    const hasRemoteActions = user.userId !== currentUser.id && Boolean(voiceRoom || canModerateRemote);
    const hasActions = hasRemoteActions || canRename || canAssignRoles;
    const menuHeight = memberActionMenuHeight({
      hasVolume: Boolean(voiceRoom && user.userId !== currentUser.id),
      canRename,
      canDisconnect: Boolean(voiceRoom && canModerateRemote),
      canModerate: canModerateRemote,
      canVoiceModerate: Boolean(voiceRoom && canModerateRemote),
      canAssignRoles
    });
    const menuKey = `directory-member:${user.userId}`;
    return (
      <div
        className={`member-row ${online ? "is-online" : "is-offline"}`}
        key={user.userId}
        onContextMenu={hasActions ? (event) => openSidebarMenuFromPointer(event, actionMenu, menuKey, 220, menuHeight) : undefined}
      >
        <span className={`avatar ${user.role === "owner" ? "owner" : ""}`}>{initial(user.nickname)}</span>
        <span className="member-copy">
          <strong>{user.nickname}</strong>
          <span>{detail}</span>
        </span>
        {user.role === "member" && user.canInvite ? <span className="member-role-tag" title={t("member.inviterRole")}><UserPlusIcon /></span> : null}
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
            onToggleInviteRole={canAssignRoles ? (canInvite) => { void onUpdateMemberPermissions(user.userId, canInvite); } : undefined}
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
