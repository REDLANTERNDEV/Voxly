import { getOwnerClaimTokenFromHash,parsePathRoute } from "../lib/navigation.js";
import type { Route,ThemeChoice } from "./types.js";

const themeKey = "voxly:theme";

export function parseRoute(pathname: string): Route {
  const route = parsePathRoute(pathname);
  if (route.name === "owner-claim") {
    return { name: "owner-claim", token: getOwnerClaimTokenFromHash(window.location.hash) };
  }
  return route;
}

export function serverPath(serverId: string, kind: "text" | "voice", roomId: string) {
  return `/app/server/${encodeURIComponent(serverId)}/${kind}/${encodeURIComponent(roomId)}`;
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(themeKey);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function saveThemeChoice(theme: ThemeChoice) {
  try {
    if (theme === "auto") window.localStorage.removeItem(themeKey);
    else window.localStorage.setItem(themeKey, theme);
  } catch {
    return;
  }
}

export function applyThemeChoice(theme: ThemeChoice) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
