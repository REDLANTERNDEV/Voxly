import type { PresenceUser } from "@voxly/shared";
import { useCallback,useEffect,useMemo,useReducer,useRef,useState } from "react";
import { ApiError,createAccessLink,fetchServerOwnerData,revokeServerInvite } from "../../api.js";
import { serverPath } from "../../app/navigation.js";
import { formatShortDate,inviteLifecycleKey,isInviteRevocable,memberRoleLabel } from "../../app/presentation.js";
import type { ShellActions,ShellModel } from "../../app/types.js";
import { ContextMenu } from "../../components/ContextMenu.js";
import { SidebarMenuTrigger,type SidebarActionMenuController } from "../../components/shell/SidebarMenus.js";
import { ConfirmDialog,NicknameDialog } from "../../components/ui/Dialogs.js";
import { ChatIcon,CopyIcon,LinkIcon,ShieldIcon,TrashIcon,UserPlusIcon,UsersIcon } from "../../components/ui/Icons.js";
import { BrandLockup,NavLink } from "../../components/ui/Navigation.js";
import { EmptyState,MemberRow,StatusPill } from "../../components/ui/Primitives.js";
import { resolveServerTextRoom } from "../../lib/channelState.js";
import { contextMenuReducer,createContextMenuDescriptor } from "../../lib/contextMenu.js";
import { inviteReference,resolveInviteOrigin } from "../../lib/invites.js";
import type { OwnerInvite,ServerMember } from "../../types.js";
import { InviteComposer } from "../invites/InviteComposer.js";
import { OwnerServerContext,SecretLinkDisplay } from "./OwnerServerContext.js";

type OwnerPanelProps = Pick<ShellModel,
  "user" | "currentNickname" | "servers" | "activeServerId" | "rooms" | "appConfig" |
  "roomHistory" | "language" | "t"
> & Pick<ShellActions,
  "onNavigate" | "onCreateServer" |
  "onUpdateServerName" | "onDeleteServer" | "onModerateMember" |
  "onVoiceModeration" | "onUpdateMemberNickname" | "onUpdateMemberPermissions"
>;

type OwnerSection = "overview" | "invites" | "members" | "server";

const ownerSections: Array<{ id: OwnerSection; titleKey: "owner.sectionOverview" | "owner.invites" | "common.members" | "owner.serverContextTitle" }> = [
  { id: "overview", titleKey: "owner.sectionOverview" },
  { id: "invites", titleKey: "owner.invites" },
  { id: "members", titleKey: "common.members" },
  { id: "server", titleKey: "owner.serverContextTitle" }
];

const memberMenuWidth = 232;

export function OwnerPanel(props: OwnerPanelProps) {
  const [section, setSection] = useState<OwnerSection>("overview");
  const [users, setUsers] = useState<ServerMember[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [accessLink, setAccessLink] = useState<{ nickname: string; token: string; expiresAt: string } | null>(null);
  const [status, setStatus] = useState("");
  const [deletingServer, setDeletingServer] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ title: string; copy: string; confirmLabel: string; perform: () => Promise<void> } | null>(null);
  const [nicknameTarget, setNicknameTarget] = useState<PresenceUser | null>(null);
  const [activeMenu, dispatchMenu] = useReducer(contextMenuReducer, null);
  const reloadRequestRef = useRef(0);
  const closeMenu = useCallback(() => dispatchMenu({ type: "close" }), []);
  const actionMenu = useMemo<SidebarActionMenuController>(() => ({
    active: activeMenu,
    close: closeMenu,
    open: (input) => dispatchMenu({
      type: "open",
      menu: createContextMenuDescriptor({ ...input, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })
    })
  }), [activeMenu, closeMenu]);

  const accessLinkUrl = accessLink
    ? `${resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)}/access/claim#token=${accessLink.token}`
    : "";
  const activeServer = props.servers.find((server) => server.id === props.activeServerId);
  const serverName = activeServer?.name ?? "Voxly";
  const ownerTextRoom = resolveServerTextRoom(
    [...props.rooms.text, ...props.rooms.voice],
    props.activeServerId,
    props.roomHistory[props.activeServerId]?.text
  );
  const ownerChatPath = ownerTextRoom
    ? serverPath(props.activeServerId, "text", ownerTextRoom.id)
    : `/app/server/${encodeURIComponent(props.activeServerId)}/owner`;

  const reload = useCallback(async () => {
    const requestId = ++reloadRequestRef.current;
    try {
      const data = await fetchServerOwnerData(props.activeServerId);
      if (requestId !== reloadRequestRef.current) return;
      setUsers(data.users);
      setInvites(data.invites);
    } catch {
      if (requestId === reloadRequestRef.current) setStatus(props.t("owner.dataError"));
    }
  }, [props.activeServerId, props.t]);

  useEffect(() => {
    setAccessLink(null);
    setStatus("");
    void reload();
    return () => {
      reloadRequestRef.current += 1;
    };
  }, [reload]);

  useEffect(() => closeMenu(), [closeMenu, section, props.activeServerId]);

  const activeMembers = users.filter((member) => !member.bannedAt);
  const stats = [
    { key: "members", label: props.t("common.members"), value: activeMembers.length, icon: <UsersIcon /> },
    { key: "inviters", label: props.t("owner.statInviters"), value: users.filter((member) => member.role === "member" && member.canInvite).length, icon: <UserPlusIcon /> },
    { key: "invites", label: props.t("owner.statActiveInvites"), value: invites.filter(isInviteRevocable).length, icon: <LinkIcon /> },
    { key: "banned", label: props.t("common.banned"), value: users.length - activeMembers.length, icon: <ShieldIcon /> }
  ];

  const requestBan = (member: ServerMember) => {
    const action = member.bannedAt ? "unban" as const : "ban" as const;
    setPendingAction({
      title: action === "ban" ? props.t("member.banTitle", { nickname: member.nickname }) : props.t("member.unbanTitle", { nickname: member.nickname }),
      copy: action === "ban" ? props.t("member.banCopy") : props.t("member.unbanCopy"),
      confirmLabel: action === "ban" ? props.t("common.ban") : props.t("common.unban"),
      perform: async () => {
        await props.onModerateMember(member.id, action);
        await reload();
      }
    });
  };

  const createMemberAccessLink = async (member: ServerMember) => {
    try {
      const response = await createAccessLink(props.activeServerId, member.id);
      setAccessLink({ nickname: member.nickname, token: response.token, expiresAt: response.expiresAt });
    } catch {
      setStatus(props.t("owner.accessLinkFailed"));
    }
  };

  return (
    <div className="dash">
      <aside className="dash-sidebar">
        <BrandLockup subtitle={props.t("owner.panel")} href={ownerChatPath} onNavigate={props.onNavigate} />
        <nav className="dash-nav" aria-label={props.t("owner.panel")}>
          {ownerSections.map((item) => (
            <button
              className={`dash-nav-item ${section === item.id ? "is-active" : ""}`}
              type="button"
              key={item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {props.t(item.titleKey)}
            </button>
          ))}
        </nav>
        <div className="dash-sidebar-foot">
          <span className="label">{props.t("owner.access")}</span>
          <MemberRow user={props.currentNickname} detail={props.t("owner.sessionDetail")} owner />
          <p className="muted small">{props.t("owner.normalViewCopy")}</p>
        </div>
      </aside>
      <main className="dash-main" id="main-content">
        <header className="dash-topbar">
          <div className="dash-topbar-copy">
            <p className="label">{serverName}</p>
            <h1>{props.t(ownerSections.find((item) => item.id === section)?.titleKey ?? "owner.title")}</h1>
          </div>
          <div className="dash-topbar-actions">
            <label className="dash-server-switch" htmlFor="dashServerSelect">
              <span className="label">{props.t("owner.targetServer")}</span>
              <select
                className="input"
                id="dashServerSelect"
                value={props.activeServerId}
                onChange={(event) => props.onNavigate(`/app/server/${encodeURIComponent(event.currentTarget.value)}/owner`)}
              >
                {props.servers.filter((server) => server.role === "owner").map((server) => (
                  <option key={server.id} value={server.id}>{server.name}</option>
                ))}
              </select>
            </label>
            <NavLink className="btn" href={ownerChatPath} onNavigate={props.onNavigate}>
              <ChatIcon />
              <span>{props.t("common.backToChat")}</span>
            </NavLink>
          </div>
        </header>

        {status ? <p className="dash-status" role="status" aria-live="polite">{status}</p> : null}

        {section === "overview" ? (
          <div className="dash-sections">
            <section className="dash-stats" aria-label={props.t("owner.sectionOverview")}>
              {stats.map((stat) => (
                <article className="dash-stat" key={stat.key}>
                  <span className="dash-stat-icon" aria-hidden="true">{stat.icon}</span>
                  <span className="dash-stat-value">{stat.value}</span>
                  <span className="dash-stat-label">{stat.label}</span>
                </article>
              ))}
            </section>
            <div className="dash-split">
              <section className="dash-panel">
                <header className="dash-panel-head">
                  <h2>{props.t("owner.createInviteFor", { server: serverName })}</h2>
                  <p className="muted small">{props.t("owner.createCopy")}</p>
                </header>
                <InviteComposer
                  serverId={props.activeServerId}
                  publicUrl={props.appConfig.publicUrl}
                  idPrefix="dashOverviewInvite"
                  t={props.t}
                  onCreated={reload}
                />
              </section>
              <section className="dash-panel">
                <header className="dash-panel-head">
                  <h2>{props.t("owner.policyTitle")}</h2>
                  <p className="muted small">{props.t("owner.policyCopy")}</p>
                </header>
                <ul className="dash-notes">
                  <li>{props.t("owner.noteDelegation")}</li>
                  <li>{props.t("owner.normalViewCopy")}</li>
                  <li>{props.t("owner.newInviteLinkCopy")}</li>
                </ul>
              </section>
            </div>
          </div>
        ) : null}

        {section === "invites" ? (
          <div className="dash-split is-invites">
            <section className="dash-panel">
              <header className="dash-panel-head">
                <h2>{props.t("owner.createInviteFor", { server: serverName })}</h2>
                <p className="muted small">{props.t("owner.createCopy")}</p>
              </header>
              <InviteComposer
                serverId={props.activeServerId}
                publicUrl={props.appConfig.publicUrl}
                idPrefix="dashInvite"
                t={props.t}
                onCreated={reload}
              />
            </section>
            <section className="dash-panel">
              <header className="dash-panel-head">
                <h2>{props.t("owner.invites")}</h2>
                <p className="muted small">{props.t("owner.inviteTableCopy")}</p>
              </header>
              {invites.length === 0 ? <EmptyState title={props.t("owner.noInvites")} copy={props.t("owner.noInvitesCopy")} /> : (
                <div className="dash-table is-invites" role="table">
                  <div className="dash-table-head" role="row">
                    <span role="columnheader">{props.t("owner.reference")}</span>
                    <span role="columnheader">{props.t("owner.uses")}</span>
                    <span role="columnheader">{props.t("common.expiry")}</span>
                    <span role="columnheader">{props.t("common.actions")}</span>
                  </div>
                  {invites.map((invite) => (
                    <div className="dash-table-row" role="row" key={invite.id}>
                      <span className="dash-cell" role="cell">
                        <strong>{invite.label || props.t("owner.unlabeledInvite")}</strong>
                        <span className="mono muted small">{inviteReference(invite.id)}</span>
                      </span>
                      <span className="dash-cell" role="cell">
                        <span>{invite.maxUses === null
                          ? props.t("invite.usedUnlimited", { used: invite.usedCount })
                          : props.t("invite.usedOfLimit", { used: invite.usedCount, limit: invite.maxUses })}</span>
                        <StatusPill tone={isInviteRevocable(invite) ? "online" : "warn"}>{props.t(inviteLifecycleKey(invite))}</StatusPill>
                      </span>
                      <span className="dash-cell" role="cell">{formatShortDate(invite.expiresAt, props.language, props.t)}</span>
                      <span className="dash-cell is-actions" role="cell">
                        <button className="btn btn-ghost" type="button" disabled={!isInviteRevocable(invite)} onClick={() => setPendingAction({
                          title: props.t("owner.revokeInviteTitle"),
                          copy: props.t("owner.revokeConfirm"),
                          confirmLabel: props.t("common.revoke"),
                          perform: async () => {
                            setStatus("");
                            await revokeServerInvite(props.activeServerId, invite.id);
                            await reload();
                          }
                        })}>
                          <TrashIcon />
                          <span>{props.t("common.revoke")}</span>
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : null}

        {section === "members" ? (
          <section className="dash-panel">
            <header className="dash-panel-head">
              <h2>{props.t("common.members")}</h2>
              <p className="muted small">{props.t("owner.memberTableCopy")}</p>
            </header>
            <div className="dash-table is-members" role="table">
              <div className="dash-table-head" role="row">
                <span role="columnheader">{props.t("common.user")}</span>
                <span role="columnheader">{props.t("common.role")}</span>
                <span role="columnheader">{props.t("common.status")}</span>
                <span role="columnheader">{props.t("common.actions")}</span>
              </div>
              {users.map((member) => {
                const menuKey = `owner-member:${member.id}`;
                const canRename = member.role !== "owner" || member.id === props.user.id;
                const isManageable = member.role !== "owner";
                return (
                  <div className="dash-table-row" role="row" key={member.id}>
                    <span className="dash-cell" role="cell">
                      <MemberRow
                        user={member.nickname}
                        detail={member.role === "owner" ? props.t("shell.ownerSession") : props.t("shell.memberSession")}
                        owner={member.role === "owner"}
                      />
                    </span>
                    <span className="dash-cell" role="cell">
                      <span className={`dash-role ${member.role === "owner" ? "is-owner" : member.canInvite ? "is-inviter" : ""}`}>
                        {memberRoleLabel(member, props.t)}
                      </span>
                    </span>
                    <span className="dash-cell" role="cell">
                      <StatusPill tone={member.bannedAt ? "danger" : "online"}>
                        {member.bannedAt ? props.t("common.banned") : props.t("common.active")}
                      </StatusPill>
                    </span>
                    <span className="dash-cell is-actions" role="cell">
                      {canRename || isManageable ? (
                        <>
                          <SidebarMenuTrigger
                            actionMenu={actionMenu}
                            menuKey={menuKey}
                            label={props.t("member.actionsFor", { nickname: member.nickname })}
                            menuWidth={memberMenuWidth}
                            menuHeight={ownerMemberMenuHeight(canRename, isManageable, Boolean(member.bannedAt))}
                          />
                          {actionMenu.active?.key === menuKey ? (
                            <ContextMenu
                              descriptor={actionMenu.active}
                              label={props.t("member.actionsFor", { nickname: member.nickname })}
                              onClose={closeMenu}
                            >
                              {canRename ? <button type="button" onClick={() => {
                                closeMenu();
                                setNicknameTarget({ userId: member.id, nickname: member.nickname, role: member.role });
                              }}>{props.t("member.changeNickname")}</button> : null}
                              {isManageable ? <>
                                <button
                                  className={member.canInvite ? "is-active" : ""}
                                  type="button"
                                  aria-pressed={member.canInvite}
                                  onClick={async () => {
                                    closeMenu();
                                    await props.onUpdateMemberPermissions(member.id, !member.canInvite);
                                    await reload();
                                  }}
                                >{member.canInvite ? props.t("member.revokeInviteRole") : props.t("member.grantInviteRole")}</button>
                                <button
                                  className={member.moderation.muted ? "is-danger" : ""}
                                  type="button"
                                  aria-pressed={member.moderation.muted}
                                  onClick={async () => {
                                    const response = await props.onVoiceModeration(member.id, { muted: !member.moderation.muted });
                                    setUsers((current) => current.map((item) => item.id === member.id ? { ...item, moderation: response.moderation } : item));
                                  }}
                                >{member.moderation.muted ? props.t("member.ownerUnmute") : props.t("member.ownerMute")}</button>
                                <button
                                  className={member.moderation.deafened ? "is-danger" : ""}
                                  type="button"
                                  aria-pressed={member.moderation.deafened}
                                  onClick={async () => {
                                    const response = await props.onVoiceModeration(member.id, { deafened: !member.moderation.deafened });
                                    setUsers((current) => current.map((item) => item.id === member.id ? { ...item, moderation: response.moderation } : item));
                                  }}
                                >{member.moderation.deafened ? props.t("member.ownerUndeafen") : props.t("member.ownerDeafen")}</button>
                                <button type="button" onClick={() => {
                                  closeMenu();
                                  void createMemberAccessLink(member);
                                }}>{props.t("owner.accessLink")}</button>
                                <button className="is-danger" type="button" onClick={() => {
                                  closeMenu();
                                  requestBan(member);
                                }}>{member.bannedAt ? props.t("common.unban") : props.t("common.ban")}</button>
                                {!member.bannedAt ? <button className="is-danger" type="button" onClick={() => {
                                  closeMenu();
                                  setPendingAction({
                                    title: props.t("member.kickTitle", { nickname: member.nickname }),
                                    copy: props.t("member.kickCopy"),
                                    confirmLabel: props.t("member.kick"),
                                    perform: async () => {
                                      await props.onModerateMember(member.id, "kick");
                                      await reload();
                                    }
                                  });
                                }}>{props.t("member.kick")}</button> : null}
                              </> : null}
                            </ContextMenu>
                          ) : null}
                        </>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
            {accessLink ? (
              <div className="dash-callout" aria-live="polite">
                <strong>{props.t("owner.accessLinkFor", { nickname: accessLink.nickname })}</strong>
                <SecretLinkDisplay key={accessLinkUrl} value={accessLinkUrl} t={props.t} />
                <p className="muted small">{props.t("owner.accessLinkCopy", { expiry: formatShortDate(accessLink.expiresAt, props.language, props.t) })}</p>
                <button className="btn btn-ghost" type="button" onClick={() => void navigator.clipboard?.writeText(accessLinkUrl)}>
                  <CopyIcon />
                  <span>{props.t("common.copy")}</span>
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {section === "server" ? (
          <OwnerServerContext
            activeServerId={props.activeServerId}
            servers={props.servers}
            t={props.t}
            onSelect={(serverId) => props.onNavigate(`/app/server/${encodeURIComponent(serverId)}/owner`)}
            onCreate={props.onCreateServer}
            onRename={props.onUpdateServerName}
            onRequestDelete={() => setDeletingServer(true)}
          />
        ) : null}

        {pendingAction ? <ConfirmDialog
          title={pendingAction.title}
          copy={pendingAction.copy}
          confirmLabel={pendingAction.confirmLabel}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            setPendingAction(null);
            void action.perform().catch(() => setStatus(props.t("owner.actionFailed")));
          }}
        /> : null}
        {deletingServer && activeServer ? <ConfirmDialog
          title={props.t("server.deleteTitle", { server: activeServer.name })}
          copy={props.t("server.deleteCopy")}
          confirmLabel={props.t("common.delete")}
          confirmationText={activeServer.name}
          confirmationLabel={props.t("common.typeToConfirm")}
          onCancel={() => setDeletingServer(false)}
          onConfirm={() => {
            setDeletingServer(false);
            setStatus("");
            void props.onDeleteServer().catch((error: unknown) => {
              if (error instanceof ApiError && error.code === "last_owner_server") {
                setStatus(props.t("server.lastServer"));
                return;
              }
              setStatus(props.t("common.deleteFailed"));
            });
          }}
        /> : null}
        {nicknameTarget ? <NicknameDialog
          user={nicknameTarget}
          t={props.t}
          onCancel={() => setNicknameTarget(null)}
          onSave={async (nickname) => {
            await props.onUpdateMemberNickname(nicknameTarget.userId, nickname);
            setNicknameTarget(null);
            setStatus(props.t("member.nicknameUpdated"));
            await reload();
          }}
        /> : null}
      </main>
    </div>
  );
}

/** Keeps the portaled member menu from being clamped to the wrong height. */
function ownerMemberMenuHeight(canRename: boolean, isManageable: boolean, isBanned: boolean) {
  return 20 + (canRename ? 40 : 0) + (isManageable ? 40 * (isBanned ? 4 : 5) : 0);
}
