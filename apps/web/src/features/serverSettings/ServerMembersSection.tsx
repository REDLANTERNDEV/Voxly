import type { PresenceUser, RoleSummary } from "@voxly/shared";
import { useCallback, useMemo, useReducer, useState } from "react";
import { memberRoleLabel } from "../../app/presentation.js";
import { MemberRolesSubmenu } from "../../components/shell/SidebarMenus.js";
import {
  canModeratePerson,
  canRenameMember,
  canVoiceModerate,
  outranksMember,
  type ModerationActor
} from "../../lib/memberDirectory.js";
import { holdsPermission, memberRoleRows, roleDisplayName } from "../../lib/roles.js";
import type { ShellActions, Translate } from "../../app/types.js";
import { ContextMenu } from "../../components/ContextMenu.js";
import { SidebarMenuTrigger, type SidebarActionMenuController } from "../../components/shell/SidebarMenus.js";
import { ConfirmDialog, NicknameDialog } from "../../components/ui/Dialogs.js";
import { MemberRow, StatusPill } from "../../components/ui/Primitives.js";
import { contextMenuReducer, createContextMenuDescriptor } from "../../lib/contextMenu.js";
import type { ServerMember } from "../../types.js";

const memberMenuWidth = 232;

/**
 * Server settings › Members: everyone in the Server, banned members included so
 * they can be unbanned, with nickname, voice moderation, ban and kick. Kicked
 * members are not listed; they may come back through an invite.
 */
export function ServerMembersSection(
  props: {
    actor: ModerationActor;
    /** Members, or the banned list with Unban alone (design decision 15). */
    mode: "members" | "bans";
    users: ServerMember[];
    serverRoles: RoleSummary[];
    t: Translate;
    onChanged: () => Promise<void>;
    onUsersChange: (update: (users: ServerMember[]) => ServerMember[]) => void;
    onError: (message: string) => void;
  } & Pick<ShellActions, "onModerateMember" | "onVoiceModeration" | "onUpdateMemberNickname" | "onSetMemberRole">
) {
  const { t, actor, mode } = props;
  const users = props.users.filter((member) => (mode === "bans" ? member.bannedAt : !member.bannedAt));
  const [pendingAction, setPendingAction] = useState<{
    title: string;
    copy: string;
    confirmLabel: string;
    perform: () => Promise<void>;
  } | null>(null);
  const [nicknameTarget, setNicknameTarget] = useState<PresenceUser | null>(null);
  const [activeMenu, dispatchMenu] = useReducer(contextMenuReducer, null);
  const closeMenu = useCallback(() => dispatchMenu({ type: "close" }), []);
  const actionMenu = useMemo<SidebarActionMenuController>(
    () => ({
      active: activeMenu,
      close: closeMenu,
      open: (input) =>
        dispatchMenu({
          type: "open",
          menu: createContextMenuDescriptor({
            ...input,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          })
        })
    }),
    [activeMenu, closeMenu]
  );

  // Counted over people: the Music bot is a member of the server but not one of
  // the members these figures are read as. It stays in the table below.
  const people = props.users.filter((member) => !member.isBot);
  const activeMembers = people.filter((member) => !member.bannedAt);

  const requestBan = (member: ServerMember) => {
    const action = member.bannedAt ? ("unban" as const) : ("ban" as const);
    setPendingAction({
      title:
        action === "ban"
          ? t("member.banTitle", { nickname: member.nickname })
          : t("member.unbanTitle", { nickname: member.nickname }),
      copy: action === "ban" ? t("member.banCopy") : t("member.unbanCopy"),
      confirmLabel: action === "ban" ? t("common.ban") : t("common.unban"),
      perform: async () => {
        await props.onModerateMember(member.id, action);
        await props.onChanged();
      }
    });
  };

  const setModeration = async (member: ServerMember, patch: { muted?: boolean; deafened?: boolean }) => {
    const response = await props.onVoiceModeration(member.id, patch);
    props.onUsersChange((current) =>
      current.map((item) => (item.id === member.id ? { ...item, moderation: response.moderation } : item))
    );
  };

  return (
    <section className="dash-panel server-settings-panel">
      <header className="dash-panel-head">
        <p className="muted small">
          {mode === "bans"
            ? t("serverSettings.bannedCount", { count: people.length - activeMembers.length })
            : t("serverSettings.memberCounts", {
                members: activeMembers.length,
                banned: people.length - activeMembers.length
              })}
        </p>
      </header>
      <div className="dash-table is-members" role="table">
        <div className="dash-table-head" role="row">
          <span role="columnheader">{t("common.user")}</span>
          <span role="columnheader">{t("serverSettings.rolesColumn")}</span>
          <span role="columnheader">{t("common.status")}</span>
          <span role="columnheader">{t("common.actions")}</span>
        </div>
        {users.map((member) => {
          const menuKey = `settings-member:${member.id}`;
          const target = { userId: member.id, role: member.role, roleIds: member.roleIds, isBot: member.isBot };
          // Each action reads the viewer's Permissions and rank, as the server
          // does (ADR-0038). Voice moderation reaches the Music bot the same way
          // it reaches anyone; the membership actions do not apply to an
          // account that cannot leave or be invited.
          const canRename = mode === "members" && canRenameMember(actor, props.serverRoles, target);
          // Moderator mute and deafen outlast a ban, so they stay reachable from › Bans.
          const canVoiceModerateMember = canVoiceModerate(actor, props.serverRoles, target);
          const canManageMembership =
            mode === "members"
              ? canModeratePerson(actor, props.serverRoles, target)
              : holdsPermission(actor, "manageMembers") && outranksMember(actor, props.serverRoles, target);
          const roleRows = mode === "members" ? memberRoleRows(actor, props.serverRoles, target) : null;
          const heldRoles = props.serverRoles.filter((role) => member.roleIds.includes(role.id));
          const hasActions = canRename || canVoiceModerateMember || canManageMembership || Boolean(roleRows);
          return (
            <div className="dash-table-row" role="row" key={member.id}>
              <span className="dash-cell" role="cell">
                <MemberRow
                  user={member.nickname}
                  detail={
                    member.isBot
                      ? t("member.botRole")
                      : member.role === "owner"
                        ? t("shell.ownerSession")
                        : t("shell.memberSession")
                  }
                  owner={member.role === "owner"}
                />
              </span>
              <span className="dash-cell" role="cell">
                {heldRoles.length > 0 ? (
                  <span className="server-member-roles">
                    {heldRoles.map((role) => (
                      <span className="dash-role" key={role.id}>
                        {roleDisplayName(role, t)}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className={`dash-role ${member.role === "owner" ? "is-owner" : ""}`}>
                    {memberRoleLabel(member, t, props.serverRoles)}
                  </span>
                )}
              </span>
              <span className="dash-cell" role="cell">
                <StatusPill tone={member.bannedAt ? "danger" : "online"}>
                  {member.bannedAt ? t("common.banned") : t("common.active")}
                </StatusPill>
              </span>
              <span className="dash-cell is-actions" role="cell">
                {hasActions ? (
                  <>
                    <SidebarMenuTrigger
                      actionMenu={actionMenu}
                      menuKey={menuKey}
                      label={t("member.actionsFor", { nickname: member.nickname })}
                      menuWidth={memberMenuWidth}
                      menuHeight={
                        memberMenuHeight(
                          canRename,
                          canVoiceModerateMember,
                          canManageMembership,
                          Boolean(member.bannedAt)
                        ) + (roleRows ? 40 : 0)
                      }
                    />
                    {actionMenu.active?.key === menuKey ? (
                      <ContextMenu
                        descriptor={actionMenu.active}
                        label={t("member.actionsFor", { nickname: member.nickname })}
                        onClose={closeMenu}
                      >
                        {canRename ? (
                          <button
                            type="button"
                            onClick={() => {
                              closeMenu();
                              setNicknameTarget({ userId: member.id, nickname: member.nickname, role: member.role });
                            }}
                          >
                            {t("member.changeNickname")}
                          </button>
                        ) : null}
                        {roleRows ? (
                          <MemberRolesSubmenu
                            nickname={member.nickname}
                            rows={roleRows}
                            onToggle={(roleId, give) => {
                              void props
                                .onSetMemberRole(member.id, roleId, give)
                                .then(props.onChanged)
                                .catch(() => props.onError(t("owner.actionFailed")));
                            }}
                            t={t}
                          />
                        ) : null}
                        {canVoiceModerateMember ? (
                          <>
                            <button
                              className={member.moderation.muted ? "is-danger" : ""}
                              type="button"
                              aria-pressed={member.moderation.muted}
                              onClick={() => {
                                void setModeration(member, { muted: !member.moderation.muted }).catch(() =>
                                  props.onError(t("owner.actionFailed"))
                                );
                              }}
                            >
                              {member.moderation.muted ? t("member.ownerUnmute") : t("member.ownerMute")}
                            </button>
                            <button
                              className={member.moderation.deafened ? "is-danger" : ""}
                              type="button"
                              aria-pressed={member.moderation.deafened}
                              onClick={() => {
                                void setModeration(member, { deafened: !member.moderation.deafened }).catch(() =>
                                  props.onError(t("owner.actionFailed"))
                                );
                              }}
                            >
                              {member.moderation.deafened ? t("member.ownerUndeafen") : t("member.ownerDeafen")}
                            </button>
                          </>
                        ) : null}
                        {canManageMembership ? (
                          <>
                            <button
                              className="is-danger"
                              type="button"
                              onClick={() => {
                                closeMenu();
                                requestBan(member);
                              }}
                            >
                              {member.bannedAt ? t("common.unban") : t("common.ban")}
                            </button>
                            {!member.bannedAt ? (
                              <button
                                className="is-danger"
                                type="button"
                                onClick={() => {
                                  closeMenu();
                                  setPendingAction({
                                    title: t("member.kickTitle", { nickname: member.nickname }),
                                    copy: t("member.kickCopy"),
                                    confirmLabel: t("member.kick"),
                                    perform: async () => {
                                      await props.onModerateMember(member.id, "kick");
                                      await props.onChanged();
                                    }
                                  });
                                }}
                              >
                                {t("member.kick")}
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </ContextMenu>
                    ) : null}
                  </>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {pendingAction ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          title={pendingAction.title}
          copy={pendingAction.copy}
          confirmLabel={pendingAction.confirmLabel}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            setPendingAction(null);
            void action.perform().catch(() => props.onError(t("owner.actionFailed")));
          }}
        />
      ) : null}
      {nicknameTarget ? (
        <NicknameDialog
          user={nicknameTarget}
          t={t}
          onCancel={() => setNicknameTarget(null)}
          onSave={async (nickname) => {
            await props.onUpdateMemberNickname(nicknameTarget.userId, nickname);
            setNicknameTarget(null);
            await props.onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

/** Keeps the portalled member menu from being clamped to the wrong height. */
function memberMenuHeight(
  canRename: boolean,
  canVoiceModerate: boolean,
  canManageMembership: boolean,
  isBanned: boolean
) {
  return 20 + (canRename ? 40 : 0) + (canVoiceModerate ? 80 : 0) + (canManageMembership ? 40 * (isBanned ? 1 : 2) : 0);
}
