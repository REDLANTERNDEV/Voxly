import { useRef, useState } from "react";
import { serverPath } from "../../app/navigation.js";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { CloseIcon, GearIcon, DownloadIcon, PlusIcon } from "../ui/Icons.js";
import { JoinServerDialog } from "../../features/invites/JoinServerDialog.js";
import { serverNotificationsMuted, serverUnreadCount, unreadBadge } from "../../lib/serverNotifications.js";
import { ContextMenu } from "../ContextMenu.js";
import { MenuSubmenu } from "../MenuSubmenu.js";
import { openSidebarMenuFromPointer, type SidebarActionMenuController } from "./SidebarMenus.js";
import { NavLink } from "../ui/Navigation.js";
import { serverMark } from "../../lib/inviteJoin.js";
import { serverMenuHeight, serverMenuItems, type ServerMenuItem } from "../../lib/serverSettings.js";

type WorkspaceRailProps = Pick<
  ShellModel,
  | "activeServerId"
  | "servers"
  | "rooms"
  | "roomHistory"
  | "t"
  | "serverNotificationState"
  | "serverNotificationTime"
  | "serverNotificationError"
> &
  Pick<ShellActions, "onNavigate" | "onSelectServer" | "onServerNotificationSettingsChange"> & {
    actionMenu: SidebarActionMenuController;
    onOpenSettings: () => void;
    onCloseDrawer: () => void;
    /** Carries out one of the server menu's own items for that Server. */
    onServerMenuItem: (serverId: string, item: ServerMenuItem) => void;
  };

const serverMenuLabels = {
  settings: "serverSettings.title",
  invite: "serverMenu.invite",
  createChannel: "serverMenu.createChannel",
  createCategory: "serverMenu.createCategory"
} as const;

export function WorkspaceRail({
  activeServerId,
  servers,
  rooms,
  roomHistory,
  t,
  onNavigate,
  onSelectServer,
  onOpenSettings,
  onCloseDrawer,
  onServerMenuItem,
  actionMenu,
  serverNotificationState,
  serverNotificationTime,
  serverNotificationError,
  onServerNotificationSettingsChange
}: WorkspaceRailProps) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);
  const joinTrigger = useRef<HTMLButtonElement>(null);
  const textRoomId = rooms.text.find((room) => room.id === roomHistory[activeServerId]?.text)?.id ?? rooms.text[0]?.id;

  return (
    <nav className="workspace-rail" aria-label={t("server.switcher")}>
      <div className="workspace-rail-routes">
        <button
          className="icon-btn workspace-drawer-close"
          type="button"
          aria-label={t("common.close")}
          onClick={onCloseDrawer}
        >
          <CloseIcon />
        </button>
        {textRoomId ? (
          <NavLink
            className="workspace-rail-brand"
            href={serverPath(activeServerId, "text", textRoomId)}
            label="Voxly"
            onNavigate={onNavigate}
          >
            <span className="brand-mark">
              <img
                className="brand-mark-image-on-light"
                src="/brand/svg/voxly-mark-monochrome-dark.svg"
                alt=""
                width="36"
                height="36"
              />
              <img
                className="brand-mark-image-on-dark"
                src="/brand/svg/voxly-mark-monochrome-light.svg"
                alt=""
                width="36"
                height="36"
              />
            </span>
          </NavLink>
        ) : null}
        <div className="workspace-servers">
          {servers.map((server) => {
            const state = serverNotificationState?.servers.find((state) => state.serverId === server.id);
            const count = serverUnreadCount(state, serverNotificationTime);
            const muted = serverNotificationsMuted(state, serverNotificationTime);
            // One menu for the Server, from its icon here and from its name in
            // the channel rail (design decision 14).
            const menuKey = `server-menu:${server.id}`;
            const items = serverMenuItems(server);
            return (
              <div className="workspace-server" key={server.id}>
                <button
                  className={`workspace-rail-link server-avatar ${server.id === activeServerId ? "is-active" : ""}`}
                  key={server.id}
                  type="button"
                  title={server.name}
                  aria-label={count ? t("server.unread", { server: server.name, count }) : server.name}
                  aria-current={server.id === activeServerId ? "page" : undefined}
                  aria-busy={switching === server.id}
                  disabled={switching !== null}
                  onContextMenu={(event) =>
                    openSidebarMenuFromPointer(event, actionMenu, menuKey, 220, serverMenuHeight(items.length))
                  }
                  onKeyDown={(event) => {
                    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    actionMenu.open({
                      key: menuKey,
                      x: rect.right,
                      y: rect.top,
                      menuWidth: 220,
                      menuHeight: serverMenuHeight(items.length),
                      trigger: event.currentTarget
                    });
                  }}
                  onClick={() => {
                    if (switching) return;
                    if (server.id === activeServerId) {
                      onCloseDrawer();
                      return;
                    }
                    setError("");
                    setSwitching(server.id);
                    void onSelectServer(server.id)
                      .catch(() => setError(t("server.switchFailed")))
                      .finally(() => setSwitching(null));
                  }}
                >
                  <span aria-hidden="true">{serverMark(server.name)}</span>
                  {count ? (
                    <span className="server-unread-badge" aria-hidden="true">
                      {unreadBadge(count)}
                    </span>
                  ) : null}
                </button>
                {actionMenu.active?.key === menuKey ? (
                  <ContextMenu
                    descriptor={actionMenu.active}
                    label={t("serverMenu.label", { server: server.name })}
                    onClose={actionMenu.close}
                  >
                    {items.map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          actionMenu.close();
                          onServerMenuItem(server.id, item);
                        }}
                      >
                        {t(serverMenuLabels[item])}
                      </button>
                    ))}
                    <MenuSubmenu
                      label={t("server.muteNotifications")}
                      items={[
                        { id: "15", label: t("server.mute15m") },
                        { id: "60", label: t("server.mute1h") },
                        { id: "180", label: t("server.mute3h") },
                        { id: "480", label: t("server.mute8h") },
                        { id: "1440", label: t("server.mute24h") },
                        { id: "indefinite", label: t("server.muteIndefinite") }
                      ]}
                      onSelect={(id) => {
                        actionMenu.close();
                        setError("");
                        void onServerNotificationSettingsChange(
                          server.id,
                          id === "indefinite"
                            ? { mode: "indefinite" }
                            : { mode: "timed", durationMinutes: Number(id) as 15 | 60 | 180 | 480 | 1440 }
                        ).catch(() => setError(t("server.notificationSaveFailed")));
                      }}
                    />
                    {muted ? (
                      <button
                        type="button"
                        onClick={() => {
                          actionMenu.close();
                          setError("");
                          void onServerNotificationSettingsChange(server.id, { mode: "enabled" }).catch(() =>
                            setError(t("server.notificationSaveFailed"))
                          );
                        }}
                      >
                        {t("server.unmuteNotifications")}
                      </button>
                    ) : null}
                  </ContextMenu>
                ) : null}
              </div>
            );
          })}
          {/* Join-only: pasting an Invite is something every member may do (ADR-0036). */}
          <button
            ref={joinTrigger}
            className="workspace-rail-link server-avatar workspace-join"
            type="button"
            title={t("server.joinOpen")}
            aria-label={t("server.joinOpen")}
            aria-haspopup="dialog"
            onClick={() => setJoining(true)}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      {joining ? (
        <JoinServerDialog
          returnFocus={joinTrigger.current}
          t={t}
          onCancel={() => setJoining(false)}
          onOpenInvite={(token) => {
            onCloseDrawer();
            onNavigate(`/invite#${encodeURIComponent(token)}`);
          }}
        />
      ) : null}
      <span className="workspace-switch-error" role="status">
        {error || (serverNotificationError ? t("server.notificationLoadFailed") : "")}
      </span>
      <div className="workspace-rail-bottom">
        {typeof window === "undefined" || window.__VOXLY_DESKTOP_V1__?.version !== 1 ? (
          <a
            className="workspace-rail-link workspace-download"
            href="https://github.com/REDLANTERNDEV/Voxly/releases"
            target="_blank"
            rel="noopener noreferrer"
            title={t("desktop.download")}
            aria-label={t("desktop.download")}
          >
            <DownloadIcon />
          </a>
        ) : null}
        <button
          className="workspace-rail-link workspace-settings"
          type="button"
          title={t("settings.open")}
          aria-label={t("settings.open")}
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </nav>
  );
}
