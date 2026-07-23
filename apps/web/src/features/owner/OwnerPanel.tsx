import type { PresenceUser } from "@voxly/shared";
import type { FormEvent } from "react";
import { useCallback,useEffect,useRef,useState } from "react";
import { ApiError,createAccessLink,createServerInvite,fetchServerOwnerData,revokeServerInvite } from "../../api.js";
import { serverPath } from "../../app/navigation.js";
import { formatShortDate,inviteLifecycleKey,isInviteRevocable } from "../../app/presentation.js";
import type { ShellActions,ShellModel } from "../../app/types.js";
import { ConfirmDialog,NicknameDialog } from "../../components/ui/Dialogs.js";
import { ChatIcon,CopyIcon,EditIcon,HeadsetIcon,LeaveIcon,MicIcon,PlusIcon,ShieldIcon,TrashIcon } from "../../components/ui/Icons.js";
import { BrandLockup,NavLink } from "../../components/ui/Navigation.js";
import { MemberRow,StatusPill } from "../../components/ui/Primitives.js";
import { resolveServerTextRoom } from "../../lib/channelState.js";
import { buildInviteUrl,inviteReference,resolveInviteOrigin } from "../../lib/invites.js";
import type { InviteExpiryMinutes,InviteMaxUses,OwnerInvite,ServerMember } from "../../types.js";
import { OwnerServerContext,SecretLinkDisplay } from "./OwnerServerContext.js";
type OwnerPanelProps = Pick<ShellModel,
  "user" | "currentNickname" | "servers" | "activeServerId" | "rooms" | "appConfig" |
  "roomHistory" | "language" | "t"
> & Pick<ShellActions,
  "onNavigate" | "onCreateServer" |
  "onUpdateServerName" | "onDeleteServer" | "onModerateMember" |
  "onVoiceModeration" | "onUpdateMemberNickname"
>;

export function OwnerPanel(props: OwnerPanelProps) {
  const [users, setUsers] = useState<ServerMember[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [expiry, setExpiry] = useState<InviteExpiryMinutes>(1440);
  const [maxUses, setMaxUses] = useState<InviteMaxUses>(1);
  const [inviteLabel, setInviteLabel] = useState("");
  const [newInvite, setNewInvite] = useState<{ id: string; token: string; label: string } | null>(null);
  const [accessLink, setAccessLink] = useState<{ nickname: string; token: string; expiresAt: string } | null>(null);
  const [status, setStatus] = useState("");
  const [deletingServer, setDeletingServer] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ title: string; copy: string; confirmLabel: string; perform: () => Promise<void> } | null>(null);
  const [nicknameTarget, setNicknameTarget] = useState<PresenceUser | null>(null);
  const reloadRequestRef = useRef(0);
  const newInviteUrl = newInvite ? buildInviteUrl(newInvite.token, resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)) : "";
  const accessLinkUrl = accessLink
    ? `${resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)}/access/claim#token=${accessLink.token}`
    : "";
  const activeServer = props.servers.find((server) => server.id === props.activeServerId);
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
    setNewInvite(null);
    setAccessLink(null);
    setStatus("");
    void reload();
    return () => {
      reloadRequestRef.current += 1;
    };
  }, [reload]);

  async function createNewInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = inviteLabel.trim();
    if (!label) {
      setStatus(props.t("owner.inviteLabelRequired"));
      return;
    }
    const response = await createServerInvite(props.activeServerId, label, expiry, maxUses);
    setNewInvite({ id: response.invite.id, token: response.invite.token, label: response.invite.label });
    setInviteLabel("");
    setStatus(props.t("owner.created"));
    await reload();
  }

  return (
    <div className="owner-shell">
      <aside className="owner-nav">
        <BrandLockup subtitle={props.t("owner.panel")} href={ownerChatPath} onNavigate={props.onNavigate} />
        <section className="rail-section">
          <a className="channel-item is-active" href="#invites"><span>{props.t("owner.invites")}</span><span /></a>
          <a className="channel-item" href="#users"><span>{props.t("common.users")}</span><span /></a>
        </section>
        <section className="session-card">
          <span className="label">{props.t("owner.access")}</span>
          <MemberRow user={props.currentNickname} detail={props.t("owner.sessionDetail")} owner />
          <p className="muted small">{props.t("owner.normalViewCopy")}</p>
        </section>
      </aside>
      <main className="owner-main" id="main-content">
        <header className="owner-hero">
          <div>
            <p className="label">{activeServer?.name ?? "Voxly"}</p>
            <h1>{props.t("owner.title")}</h1>
            <p className="muted">{props.t("owner.heroCopy")}</p>
          </div>
          <NavLink className="btn" href={ownerChatPath} onNavigate={props.onNavigate}>
            <ChatIcon />
            <span>{props.t("common.backToChat")}</span>
          </NavLink>
        </header>
        <OwnerServerContext
          activeServerId={props.activeServerId}
          servers={props.servers}
          t={props.t}
          onSelect={(serverId) => props.onNavigate(`/app/server/${encodeURIComponent(serverId)}/owner`)}
          onCreate={props.onCreateServer}
          onRename={props.onUpdateServerName}
          onRequestDelete={() => setDeletingServer(true)}
        />
        <section className="owner-grid" id="invites">
          <form className="owner-card" onSubmit={createNewInvite}>
            <div>
              <h2>{props.t("owner.createInviteFor", { server: activeServer?.name ?? "Voxly" })}</h2>
              <p className="muted small">{props.t("owner.createCopy")}</p>
            </div>
            <label className="form-field" htmlFor="inviteLabel">
              <span>{props.t("owner.inviteLabel")}</span>
              <input className="input" id="inviteLabel" name="inviteLabel" value={inviteLabel} onChange={(event) => setInviteLabel(event.target.value)} placeholder={props.t("owner.inviteLabelPlaceholder")} maxLength={80} />
            </label>
            <label className="form-field" htmlFor="expiry">
              <span>{props.t("owner.expiresAfter")}</span>
              <select className="input" id="expiry" name="expiry" value={expiry ?? "never"} onChange={(event) => setExpiry(event.target.value === "never" ? null : Number(event.target.value) as InviteExpiryMinutes)}>
                <option value="30">{props.t("invite.expiry30m")}</option>
                <option value="60">{props.t("invite.expiry1h")}</option>
                <option value="360">{props.t("invite.expiry6h")}</option>
                <option value="720">{props.t("invite.expiry12h")}</option>
                <option value="1440">{props.t("invite.expiry1d")}</option>
                <option value="10080">{props.t("invite.expiry7d")}</option>
                <option value="43200">{props.t("invite.expiry30d")}</option>
                <option value="never">{props.t("common.noExpiry")}</option>
              </select>
            </label>
            <label className="form-field" htmlFor="maxUses">
              <span>{props.t("owner.maxUses")}</span>
              <select className="input" id="maxUses" name="maxUses" value={maxUses ?? "unlimited"} onChange={(event) => setMaxUses(event.target.value === "unlimited" ? null : Number(event.target.value) as InviteMaxUses)}>
                {[1, 5, 10, 25, 50, 100].map((count) => <option key={count} value={count}>{props.t("invite.useCount", { count })}</option>)}
                <option value="unlimited">{props.t("invite.unlimitedUses")}</option>
              </select>
            </label>
            <button className="btn btn-primary" type="submit">
              <PlusIcon />
              <span>{props.t("common.createInvite")}</span>
            </button>
            {newInviteUrl ? (
              <div className="invite-status is-valid">
                <strong>{props.t("owner.newInviteLink")}</strong>
                <span>{newInvite?.label}</span>
                <SecretLinkDisplay key={newInviteUrl} value={newInviteUrl} t={props.t} />
                <span className="muted small">{props.t("owner.newInviteLinkCopy")}</span>
                <button className="btn btn-ghost" type="button" onClick={async () => {
                  try {
                    await navigator.clipboard?.writeText(newInviteUrl);
                    setStatus(props.t("owner.copied"));
                  } catch {
                    setStatus(props.t("owner.copyFailed"));
                  }
                }}>
                  <CopyIcon />
                  <span>{props.t("common.copy")}</span>
                </button>
              </div>
            ) : null}
          </form>
          <section className="table-card">
            <div className="table-head"><span>{props.t("owner.reference")}</span><span>{props.t("owner.uses")}</span><span>{props.t("common.expiry")}</span><span>{props.t("common.actions")}</span></div>
            {invites.map((invite) => (
              <div className="table-row" key={invite.id}>
                <span><strong>{invite.label || props.t("owner.unlabeledInvite")}</strong><br /><span className="mono muted small">{inviteReference(invite.id)}</span></span>
                <span>{invite.maxUses === null
                  ? props.t("invite.usedUnlimited", { used: invite.usedCount })
                  : `${props.t("invite.usedOfLimit", { used: invite.usedCount, limit: invite.maxUses })} · ${props.t("invite.remainingUses", { count: Math.max(0, invite.maxUses - invite.usedCount) })}`}
                  <br /><span className="muted small">{props.t(inviteLifecycleKey(invite))}</span>
                </span>
                <span>{formatShortDate(invite.expiresAt, props.language, props.t)}</span>
                <span>
                  <button className="btn btn-danger" type="button" disabled={!isInviteRevocable(invite)} onClick={() => setPendingAction({
                    title: "Revoke invite?",
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
          </section>
        </section>
        <section className="owner-grid members-grid" id="users">
          <section className="table-card">
            <div className="table-head"><span>{props.t("common.user")}</span><span>{props.t("common.role")}</span><span>{props.t("common.status")}</span><span>{props.t("common.actions")}</span></div>
            {users.map((item) => (
              <div className="table-row" key={item.id}>
                <span><MemberRow user={item.nickname} detail={item.role === "owner" ? props.t("shell.ownerSession") : props.t("shell.memberSession")} owner={item.role === "owner"} /></span>
                <span>{item.role === "owner" ? props.t("common.owner") : props.t("common.user")}</span>
                <span><StatusPill tone={item.bannedAt ? "danger" : "online"}>{item.bannedAt ? props.t("common.banned") : props.t("common.active")}</StatusPill></span>
                <span className="table-actions">
                  {(item.role !== "owner" || item.id === props.user.id) ? <button className="btn btn-ghost" type="button" onClick={() => setNicknameTarget({
                    userId: item.id,
                    nickname: item.nickname,
                    role: item.role
                  })}><EditIcon /><span>{props.t("member.changeNickname")}</span></button> : null}
                  {item.role !== "owner" ? <>
                    <button className={`btn ${item.moderation.muted ? "btn-danger moderation-toggle is-enforced" : "btn-ghost moderation-toggle"}`} type="button" aria-pressed={item.moderation.muted} onClick={async () => {
                      const response = await props.onVoiceModeration(item.id, { muted: !item.moderation.muted });
                      setUsers((current) => current.map((member) => member.id === item.id ? { ...member, moderation: response.moderation } : member));
                    }}><MicIcon off={item.moderation.muted} /><span>{item.moderation.muted ? props.t("member.ownerUnmute") : props.t("member.ownerMute")}</span></button>
                    <button className={`btn ${item.moderation.deafened ? "btn-danger moderation-toggle is-enforced" : "btn-ghost moderation-toggle"}`} type="button" aria-pressed={item.moderation.deafened} onClick={async () => {
                      const response = await props.onVoiceModeration(item.id, { deafened: !item.moderation.deafened });
                      setUsers((current) => current.map((member) => member.id === item.id ? { ...member, moderation: response.moderation } : member));
                    }}><HeadsetIcon off={item.moderation.deafened} /><span>{item.moderation.deafened ? props.t("member.ownerUndeafen") : props.t("member.ownerDeafen")}</span></button>
                    <button className="btn btn-ghost" type="button" onClick={async () => {
                      try {
                        const response = await createAccessLink(props.activeServerId, item.id);
                        setAccessLink({ nickname: item.nickname, token: response.token, expiresAt: response.expiresAt });
                      } catch {
                        setStatus("Access link could not be created.");
                      }
                    }}><CopyIcon /><span>Access link</span></button>
                    <button className="btn btn-danger" type="button" onClick={() => {
                      const action = item.bannedAt ? "unban" : "ban";
                      setPendingAction({
                        title: action === "ban" ? `Ban ${item.nickname}?` : `Unban ${item.nickname}?`,
                        copy: action === "ban" ? props.t("owner.banConfirm", { nickname: item.nickname }) : "This restores the member's access to this server.",
                        confirmLabel: action === "ban" ? props.t("common.ban") : "Unban",
                        perform: async () => {
                          await props.onModerateMember(item.id, action);
                          await reload();
                        }
                      });
                    }}>
                      <ShieldIcon />
                      <span>{item.bannedAt ? "Unban" : props.t("common.ban")}</span>
                    </button>
                    {!item.bannedAt ? <button className="btn btn-danger" type="button" onClick={() => setPendingAction({
                      title: `Kick ${item.nickname}?`,
                      copy: "The member can return only with a new invite.",
                      confirmLabel: "Kick",
                      perform: async () => {
                        await props.onModerateMember(item.id, "kick");
                        await reload();
                      }
                    })}><LeaveIcon /><span>Kick</span></button> : null}
                  </> : null}
                </span>
              </div>
            ))}
          </section>
          <section className="owner-card">
            <h2>{props.t("owner.policyTitle")}</h2>
            <p className="muted">{props.t("owner.policyCopy")}</p>
            <div className="invite-status is-valid"><strong>{props.t("owner.normalView")}</strong><span className="muted small">{props.t("owner.normalViewCopy")}</span></div>
          </section>
        </section>
        {accessLink ? (
          <section className="owner-card access-link-card" aria-live="polite">
            <h2>Access link for {accessLink.nickname}</h2>
            <SecretLinkDisplay key={accessLinkUrl} value={accessLinkUrl} t={props.t} />
            <p className="muted small">Expires {formatShortDate(accessLink.expiresAt, props.language, props.t)}. It can be used once.</p>
            <button className="btn btn-ghost" type="button" onClick={() => void navigator.clipboard?.writeText(accessLinkUrl)}><CopyIcon /><span>{props.t("common.copy")}</span></button>
          </section>
        ) : null}
        <p className="error-text" aria-live="polite">{status}</p>
        {pendingAction ? <ConfirmDialog
          title={pendingAction.title}
          copy={pendingAction.copy}
          confirmLabel={pendingAction.confirmLabel}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            const action = pendingAction;
            setPendingAction(null);
            void action.perform().catch(() => setStatus("This action could not be completed."));
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
