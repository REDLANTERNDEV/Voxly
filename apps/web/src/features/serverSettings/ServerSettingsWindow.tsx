import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchServerInvites, fetchServerMembers } from "../../api.js";
import { moderationActor } from "../../app/presentation.js";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import {
  ArrowIcon,
  CloseIcon,
  GearIcon,
  LinkIcon,
  ShieldIcon,
  TrashIcon,
  UsersIcon
} from "../../components/ui/Icons.js";
import { isOwnerOnlySection, serverSettingsSections, type ServerSettingsSection } from "../../lib/serverSettings.js";
import type { OwnerInvite, ServerMember } from "../../types.js";
import { ServerOverviewSettings } from "../owner/OwnerServerContext.js";
import { ServerAccessLinksSection, ServerInviteTrailSection } from "./ServerAccessSections.js";
import { ServerMembersSection } from "./ServerMembersSection.js";
import { ServerRolesSection } from "./ServerRolesSection.js";

const sectionTitles = {
  overview: "serverSettings.overview",
  invites: "serverSettings.invites",
  bans: "serverSettings.bans",
  roles: "serverSettings.roles",
  members: "serverSettings.members",
  inviteTrail: "serverSettings.inviteTrail",
  accessLinks: "serverSettings.accessLinks",
  deleteServer: "serverSettings.deleteServer"
} as const;

const sectionIcons = {
  overview: <GearIcon />,
  invites: <LinkIcon />,
  bans: <ShieldIcon />,
  roles: <ShieldIcon />,
  members: <UsersIcon />,
  inviteTrail: <ShieldIcon />,
  accessLinks: <LinkIcon />,
  deleteServer: <TrashIcon />
} as const;

/** The first element a user can see, so focus never lands on a hidden control. */
function firstVisible(...elements: Array<HTMLElement | null | undefined>) {
  return elements.find((element) => element && element.getClientRects().length > 0) ?? null;
}

const focusable =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea, [tabindex]:not([tabindex="-1"])';

export type ServerSettingsWindowProps = Pick<
  ShellModel,
  | "user"
  | "servers"
  | "serverRoles"
  | "serverMembers"
  | "activeServerId"
  | "rooms"
  | "appConfig"
  | "language"
  | "timeFormat"
  | "t"
> &
  Pick<
    ShellActions,
    | "onUpdateServerName"
    | "onSetAfkTimeout"
    | "onSetWelcome"
    | "onDeleteServer"
    | "onModerateMember"
    | "onVoiceModeration"
    | "onUpdateMemberNickname"
    | "onCreateRole"
    | "onUpdateRole"
    | "onReorderRoles"
    | "onDeleteRole"
    | "onSetMemberRole"
  > & {
    onClose: () => void;
  };

/**
 * Server settings (ADR-0038, design decisions 15 and 20): a full-screen window
 * with a section list on the left, in the style of Discord's. A member sees only
 * the sections their Permissions reach, worked out from the `ServerSummary` the
 * server keeps current; a section they lose closes at once, and with none left
 * the window closes. On a phone it is two steps: the list, then one section
 * full-screen with a way back.
 */
export function ServerSettingsWindow(props: ServerSettingsWindowProps) {
  const { t } = props;
  const server = props.servers.find((item) => item.id === props.activeServerId);
  const sections = serverSettingsSections(server);
  const [chosen, setChosen] = useState<ServerSettingsSection>(sections[0] ?? "overview");
  const chosenReachable = sections.includes(chosen);
  const section = chosenReachable ? chosen : sections[0];
  // On a phone a section that was lost goes back to the list, rather than
  // swapping another section in under the member's thumb.
  const [showingSectionRaw, setShowingSection] = useState(false);
  const showingSection = showingSectionRaw && chosenReachable;
  const [users, setUsers] = useState<ServerMember[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const navCloseRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const requestRef = useRef(0);
  const actor = moderationActor(props);
  const readsMembers = sections.includes("members");
  const readsInvites = Boolean(server?.permissions.includes("manageInvites"));
  const serverId = props.activeServerId;

  const reload = useCallback(async () => {
    // Each list is asked for only by someone whose Permissions reach it.
    if (!readsMembers && !readsInvites) return;
    const requestId = ++requestRef.current;
    try {
      const [members, invitesResponse] = await Promise.all([
        readsMembers ? fetchServerMembers(serverId) : null,
        readsInvites ? fetchServerInvites(serverId) : null
      ]);
      if (requestId !== requestRef.current) return;
      if (members) setUsers(members.members);
      if (invitesResponse) setInvites(invitesResponse.invites);
    } catch {
      if (requestId === requestRef.current) setStatus(t("owner.dataError"));
    }
  }, [readsMembers, readsInvites, serverId, t]);

  useEffect(() => {
    setStatus("");
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  // The directory and Roles change live (decision 22); the moderation list
  // follows them rather than keeping what it read when the window opened.
  const directoryVersion = props.serverMembers;
  const rolesVersion = props.serverRoles;
  const firstLoad = useRef(true);
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void reload();
  }, [directoryVersion, rolesVersion, reload]);

  // Losing the last Permission that reached anything closes the window itself.
  const empty = sections.length === 0;
  useEffect(() => {
    if (empty) onCloseRef.current();
  }, [empty]);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    // On a phone the list is shown first and the header's close is hidden.
    firstVisible(closeRef.current, navCloseRef.current)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal window keeps Tab inside itself; dialogs and menus opened over
      // it keep their own.
      if (event.key === "Tab" && windowRef.current && windowRef.current.contains(document.activeElement)) {
        const items = Array.from(windowRef.current.querySelectorAll<HTMLElement>(focusable)).filter(
          (element) => element.getClientRects().length > 0
        );
        const first = items[0];
        const last = items[items.length - 1];
        if (first && last) {
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open], .confirm-dialog, .chat-dialog, .sidebar-context-menu")
      )
        onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  if (!server || !section) return null;

  const groups = [
    { key: "server", heading: null, items: sections.filter((item) => !isOwnerOnlySection(item)) },
    {
      key: "owner",
      heading: t("serverSettings.ownerHeading"),
      items: sections.filter((item) => isOwnerOnlySection(item))
    }
  ].filter((group) => group.items.length > 0);

  const backToList = () => {
    setShowingSection(false);
    window.setTimeout(() => navRef.current?.querySelector<HTMLElement>(`[data-section="${section}"]`)?.focus(), 0);
  };

  // The owner may not delete the last Server they own; the server refuses it too.
  const ownedServers = props.servers.filter((item) => item.role === "owner").length;

  return (
    <div
      ref={windowRef}
      className={`server-settings ${showingSection ? "is-showing-section" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("serverSettings.titleFor", { server: server.name })}
    >
      <nav className="server-settings-nav" ref={navRef} aria-label={t("serverSettings.title")}>
        <div className="server-settings-nav-inner">
          <div className="server-settings-nav-head">
            <span className="label server-settings-nav-server" title={server.name}>
              {server.name}
            </span>
            {/* On a phone the list is a screen of its own, so it needs its own way out. */}
            <button
              ref={navCloseRef}
              className="icon-btn server-settings-nav-close"
              type="button"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={props.onClose}
            >
              <CloseIcon />
            </button>
          </div>
          {groups.map((group) => (
            <div
              className="server-settings-nav-group"
              key={group.key}
              role={group.heading ? "group" : undefined}
              aria-labelledby={group.heading ? `serverSettingsNav-${group.key}` : undefined}
            >
              {group.heading ? (
                <span className="label server-settings-nav-heading" id={`serverSettingsNav-${group.key}`}>
                  {group.heading}
                </span>
              ) : null}
              {group.items.map((item) => (
                <button
                  className={`settings-nav-item server-settings-nav-item${item === "deleteServer" ? " is-danger" : ""}`}
                  type="button"
                  key={item}
                  data-section={item}
                  aria-current={section === item ? true : undefined}
                  onClick={() => {
                    setChosen(item);
                    setShowingSection(true);
                    setStatus("");
                    // On a phone the list this button sits in is about to be
                    // hidden; the section's own way back takes focus instead.
                    window.setTimeout(() => {
                      if (backRef.current?.getClientRects().length) backRef.current.focus();
                    }, 0);
                  }}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    {sectionIcons[item]}
                  </span>
                  <span>{t(sectionTitles[item])}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <div className="server-settings-body">
        <header className="server-settings-header">
          <button ref={backRef} className="icon-btn server-settings-back" type="button" onClick={backToList}>
            <ArrowIcon />
            <span className="sr-only">{t("serverSettings.back")}</span>
          </button>
          <h2>{t(sectionTitles[section])}</h2>
          <button
            className="settings-close icon-btn server-settings-close"
            type="button"
            title={t("common.close")}
            aria-label={t("common.close")}
            ref={closeRef}
            onClick={props.onClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="server-settings-content">
          {status ? (
            <p className="dash-status" role="status" aria-live="polite">
              {status}
            </p>
          ) : null}
          {section === "overview" ? (
            <ServerOverviewSettings
              server={server}
              t={t}
              onRename={props.onUpdateServerName}
              onSetAfkTimeout={props.onSetAfkTimeout}
              textRooms={props.rooms.text}
              onSetWelcome={props.onSetWelcome}
            />
          ) : null}
          {section === "roles" ? (
            <ServerRolesSection
              actor={server}
              roles={props.serverRoles}
              members={props.serverMembers}
              t={t}
              onError={setStatus}
              onCreateRole={props.onCreateRole}
              onUpdateRole={props.onUpdateRole}
              onReorderRoles={props.onReorderRoles}
              onDeleteRole={props.onDeleteRole}
              onSetMemberRole={props.onSetMemberRole}
            />
          ) : null}
          {(section === "members" || section === "bans") && actor ? (
            <ServerMembersSection
              key={section}
              actor={actor}
              mode={section}
              users={users}
              serverRoles={props.serverRoles}
              t={t}
              onChanged={reload}
              onUsersChange={setUsers}
              onError={setStatus}
              onModerateMember={props.onModerateMember}
              onVoiceModeration={props.onVoiceModeration}
              onUpdateMemberNickname={props.onUpdateMemberNickname}
              onSetMemberRole={props.onSetMemberRole}
            />
          ) : null}
          {section === "invites" ? (
            <ServerInviteTrailSection
              serverId={serverId}
              invites={invites}
              showTrail={false}
              language={props.language}
              timeFormat={props.timeFormat}
              t={t}
              onChanged={reload}
              onError={setStatus}
            />
          ) : null}
          {section === "inviteTrail" ? (
            <ServerInviteTrailSection
              serverId={serverId}
              invites={invites}
              language={props.language}
              timeFormat={props.timeFormat}
              t={t}
              onChanged={reload}
              onError={setStatus}
            />
          ) : null}
          {section === "accessLinks" ? (
            <ServerAccessLinksSection
              serverId={serverId}
              users={users}
              publicUrl={props.appConfig.publicUrl}
              language={props.language}
              timeFormat={props.timeFormat}
              t={t}
              onError={setStatus}
            />
          ) : null}
          {section === "deleteServer" ? (
            <section className="dash-panel server-settings-panel owner-server-danger">
              <div>
                <p className="muted small">{t("server.deleteCopy")}</p>
              </div>
              <button
                className="btn btn-danger"
                type="button"
                disabled={ownedServers <= 1}
                onClick={() => setDeleting(true)}
              >
                <TrashIcon />
                <span>{t("server.delete")}</span>
              </button>
            </section>
          ) : null}
        </div>
      </div>
      {deleting ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          title={t("server.deleteTitle", { server: server.name })}
          copy={t("server.deleteCopy")}
          confirmLabel={t("common.delete")}
          confirmationText={server.name}
          confirmationLabel={t("common.typeToConfirm")}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            setStatus("");
            void props
              .onDeleteServer()
              .then(() => props.onClose())
              .catch((error: unknown) => {
                if (error instanceof ApiError && error.code === "last_owner_server") {
                  setStatus(t("server.lastServer"));
                  return;
                }
                setStatus(t("common.deleteFailed"));
              });
          }}
        />
      ) : null}
    </div>
  );
}
