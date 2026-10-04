import type { Translate } from "../app/types.js";
import type { MouseEvent } from "react";
import { useApplicationUpdates, webReleaseVersion } from "../lib/applicationUpdates.js";
import { desktopUpdateNotice } from "../lib/desktopUpdates.js";
import { RefreshIcon } from "./ui/Icons.js";

export function ApplicationUpdateStatus({ t, surface = "dock", onSelect }: { t: Translate; surface?: "dock" | "account" | "settings"; onSelect?: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const update = useApplicationUpdates();
  const desktopNotice = desktopUpdateNotice(update.desktop);
  const notice = surface === "account" && (desktopNotice === "error" || desktopNotice === "invalid" || desktopNotice === "reviewError") ? null : desktopNotice;
  const menu = surface !== "dock";
  const version = update.desktop?.currentVersion;
  const next = update.desktop?.version;
  const label = notice ? t(`desktopUpdate.${notice}`) : update.pendingClient ? t(update.clientBusy ? "clientUpdate.afterCall" : "clientUpdate.ready") : null;
  const disabled = notice === "installing" || !notice && update.clientBusy;
  const select = (event: MouseEvent<HTMLButtonElement>) => { onSelect?.(event); if (notice) void update.reviewDesktop(); else update.reloadClient(); };
  const versions = version ? `v${version}${next && notice === "ready" ? ` → v${next}` : ""}` : "";
  return <>
    {!menu ? <span className="sr-only" role="status" aria-live="polite">{label}</span> : null}
    {label ? <button type="button" className={menu ? "btn btn-ghost account-update-link" : "dock-update-link"} disabled={disabled} onClick={select} aria-label={[label, versions].filter(Boolean).join(" · ")} title={[label, versions].filter(Boolean).join(" · ")}>
      <RefreshIcon /><span className="update-label">{label}</span>
    </button> : null}
  </>;
}

export function ApplicationVersionSettings({ t }: { t: Translate }) {
  const { desktop, reviewDesktop } = useApplicationUpdates();
  return <section className="application-version-settings" aria-label={t("settings.about")}>
    <h3>{t("settings.about")}</h3>
    <dl>{desktop ? <><dt>{t("settings.desktopVersion")}</dt><dd>v{desktop.currentVersion}</dd></> : null}<dt>{t("settings.webVersion")}</dt><dd>{webReleaseVersion ? `v${webReleaseVersion}` : "—"}</dd></dl>
    <ApplicationUpdateStatus t={t} surface="settings" />
    {desktop && desktop.phase !== "disabled" && !desktopUpdateNotice(desktop) ? <button type="button" className="btn" onClick={() => void reviewDesktop()}>{t("desktopUpdate.manage")}</button> : null}
  </section>;
}
