import type { Translate } from "../app/types.js";
import { desktopOpenLink } from "../lib/desktopLinks.js";

export function OpenInDesktop({ t }: { t: Translate }) {
  const href = typeof window === "undefined" ? null
    : desktopOpenLink(window.location.origin, window.__VOXLY_DESKTOP_V1__?.version === 1);
  if (!href) return null;
  return <a className="btn btn-ghost" href={href} title={t("desktop.openHint")}>{t("desktop.open")}</a>;
}
