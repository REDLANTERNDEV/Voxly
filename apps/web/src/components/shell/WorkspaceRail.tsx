import { useState } from "react";
import { serverPath } from "../../app/navigation.js";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { CloseIcon, GearIcon, DownloadIcon } from "../ui/Icons.js";
import { NavLink } from "../ui/Navigation.js";

type WorkspaceRailProps = Pick<ShellModel, "activeServerId" | "servers" | "rooms" | "roomHistory" | "t"> & Pick<ShellActions, "onNavigate" | "onSelectServer"> & {
  onOpenSettings: () => void;
  onCloseDrawer: () => void;
};

export function WorkspaceRail({ activeServerId, servers, rooms, roomHistory, t, onNavigate, onSelectServer, onOpenSettings, onCloseDrawer }: WorkspaceRailProps) {
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState("");
  const textRoomId = rooms.text.find((room) => room.id === roomHistory[activeServerId]?.text)?.id ?? rooms.text[0]?.id;

  return <nav className="workspace-rail" aria-label={t("server.switcher")}>
    <div className="workspace-rail-routes">
      <button className="icon-btn workspace-drawer-close" type="button" aria-label={t("common.close")} onClick={onCloseDrawer}><CloseIcon /></button>
      {textRoomId ? <NavLink className="workspace-rail-brand" href={serverPath(activeServerId, "text", textRoomId)} label="Voxly" onNavigate={onNavigate}>
        <span className="brand-mark">
          <img className="brand-mark-image-on-light" src="/brand/svg/voxly-mark-monochrome-dark.svg" alt="" width="36" height="36" />
          <img className="brand-mark-image-on-dark" src="/brand/svg/voxly-mark-monochrome-light.svg" alt="" width="36" height="36" />
        </span>
      </NavLink> : null}
      <div className="workspace-servers">
        {servers.map((server) => <button
          className={`workspace-rail-link server-avatar ${server.id === activeServerId ? "is-active" : ""}`}
          key={server.id} type="button" title={server.name} aria-label={server.name}
          aria-current={server.id === activeServerId ? "page" : undefined}
          aria-busy={switching === server.id} disabled={switching !== null}
          onClick={() => {
            if (switching) return;
            if (server.id === activeServerId) { onCloseDrawer(); return; }
            setError(""); setSwitching(server.id);
            void onSelectServer(server.id).catch(() => setError(t("server.switchFailed"))).finally(() => setSwitching(null));
          }}
        ><span aria-hidden="true">{Array.from(server.name.trim())[0]?.toLocaleUpperCase() ?? "V"}</span></button>)}
      </div>
      {typeof window === "undefined" || window.__VOXLY_DESKTOP_V1__?.version !== 1 ? <a className="workspace-rail-link workspace-download" href="https://github.com/REDLANTERNDEV/Voxly/releases" target="_blank" rel="noopener noreferrer" title={t("desktop.download")} aria-label={t("desktop.download")}><DownloadIcon /></a> : null}
    </div>
    <span className="workspace-switch-error" role="status">{error}</span>
    <button className="workspace-rail-link workspace-settings" type="button" title={t("settings.open")} aria-label={t("settings.open")} onClick={onOpenSettings}><GearIcon /></button>
  </nav>;
}
