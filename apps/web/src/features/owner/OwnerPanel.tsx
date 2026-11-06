import { useEffect, useState } from "react";
import { fetchOwnerDeletionRequests } from "../../api.js";
import { serverPath } from "../../app/navigation.js";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { ChatIcon, ShieldIcon, TrashIcon, UserPlusIcon } from "../../components/ui/Icons.js";
import { BrandLockup, NavLink } from "../../components/ui/Navigation.js";
import { MemberRow } from "../../components/ui/Primitives.js";
import { resolveServerTextRoom } from "../../lib/channelState.js";
import { CreateServerSection } from "./OwnerServerContext.js";
import { OwnerAccountsSection, OwnerDeletionRequestsSection } from "./OwnerAccountSections.js";

type OwnerPanelProps = Pick<
  ShellModel,
  | "user"
  | "currentNickname"
  | "activeServerId"
  | "rooms"
  | "roomHistory"
  | "language"
  | "timeFormat"
  | "deletionRequestRevision"
  | "t"
> &
  Pick<ShellActions, "onNavigate" | "onCreateServer">;

type OwnerSection = "overview" | "deletionRequests" | "accounts";

const ownerSections: Array<{
  id: OwnerSection;
  titleKey: "owner.installationOverview" | "ownerAccounts.deletionRequests" | "ownerAccounts.accounts";
}> = [
  { id: "overview", titleKey: "owner.installationOverview" },
  { id: "deletionRequests", titleKey: "ownerAccounts.deletionRequests" },
  { id: "accounts", titleKey: "ownerAccounts.accounts" }
];

const ownerSectionIcons = {
  overview: <ShieldIcon />,
  deletionRequests: <TrashIcon />,
  accounts: <UserPlusIcon />
} as const;

/**
 * The owner panel: what covers the whole installation, and nothing about one
 * Server (ADR-0038, design decision 16). One Server's settings live in Server
 * settings, opened from its name; this keeps the Installation owner's Accounts,
 * Deletion requests and a way to start a new Server.
 */
export function OwnerPanel(props: OwnerPanelProps) {
  const [section, setSection] = useState<OwnerSection>("overview");
  const [deletionRequestCount, setDeletionRequestCount] = useState(0);
  const isInstallationOwner = props.user.role === "owner";

  const ownerTextRoom = resolveServerTextRoom(
    [...props.rooms.text, ...props.rooms.voice],
    props.activeServerId,
    props.roomHistory[props.activeServerId]?.text
  );
  const ownerChatPath = ownerTextRoom
    ? serverPath(props.activeServerId, "text", ownerTextRoom.id)
    : `/app/server/${encodeURIComponent(props.activeServerId)}/owner`;

  useEffect(() => {
    if (!isInstallationOwner) return;
    void fetchOwnerDeletionRequests()
      .then((response) => setDeletionRequestCount(response.requests.length))
      .catch(() => undefined);
  }, [props.deletionRequestRevision, isInstallationOwner]);

  return (
    <div className="dash">
      <aside className="dash-sidebar">
        <BrandLockup subtitle={props.t("owner.panel")} href={ownerChatPath} onNavigate={props.onNavigate} />
        <nav className="dash-nav" aria-label={props.t("owner.panel")}>
          <div className="dash-nav-group" role="group" aria-labelledby="dashNav-installation">
            <span className="dash-nav-heading label" id="dashNav-installation">
              {props.t("owner.installationHeading")}
            </span>
            {ownerSections.map((item) => (
              <button
                className={`dash-nav-item ${section === item.id ? "is-active" : ""}`}
                type="button"
                key={item.id}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => setSection(item.id)}
              >
                <span className="dash-nav-icon" aria-hidden="true">
                  {ownerSectionIcons[item.id]}
                </span>
                {props.t(item.titleKey)}
                {item.id === "deletionRequests" && deletionRequestCount > 0 ? (
                  <span className="owner-alert-badge">{deletionRequestCount}</span>
                ) : null}
              </button>
            ))}
          </div>
        </nav>
        <div className="dash-sidebar-foot">
          <span className="label">{props.t("owner.access")}</span>
          <MemberRow user={props.currentNickname} detail={props.t("owner.sessionDetail")} owner />
        </div>
      </aside>
      <main className="dash-main" id="main-content">
        <header className="dash-topbar">
          <div className="dash-topbar-copy">
            <p className="label">{props.t("owner.installationHeading")}</p>
            <h1>
              {props.t(ownerSections.find((item) => item.id === section)?.titleKey ?? "owner.installationOverview")}
            </h1>
          </div>
          <div className="dash-topbar-actions">
            <p className="dash-server-scope muted small">{props.t("owner.installationScope")}</p>
            <NavLink className="btn" href={ownerChatPath} onNavigate={props.onNavigate}>
              <ChatIcon />
              <span>{props.t("common.backToChat")}</span>
            </NavLink>
          </div>
        </header>

        {section === "overview" ? (
          <div className="dash-sections">
            <p className="muted small">{props.t("owner.installationCopy")}</p>
            <CreateServerSection t={props.t} onCreate={props.onCreateServer} />
          </div>
        ) : null}

        {section === "deletionRequests" && isInstallationOwner ? (
          <OwnerDeletionRequestsSection
            language={props.language}
            timeFormat={props.timeFormat}
            revision={props.deletionRequestRevision}
            t={props.t}
            onCountChange={setDeletionRequestCount}
          />
        ) : null}

        {section === "accounts" && isInstallationOwner ? (
          <OwnerAccountsSection language={props.language} timeFormat={props.timeFormat} t={props.t} />
        ) : null}
      </main>
    </div>
  );
}
