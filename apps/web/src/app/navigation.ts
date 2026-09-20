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

  const mediaQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  const updateThemeColor = () => {
    const effectiveTheme = theme === "auto" && mediaQuery?.matches ? "dark" : theme === "dark" ? "dark" : "light";
    document.querySelector?.('meta[name="theme-color"]')?.setAttribute("content", effectiveTheme === "dark" ? "#0B0F14" : "#FFFFFF");
  };
  updateThemeColor();
  if (theme !== "auto" || !mediaQuery) return;
  mediaQuery.addEventListener("change", updateThemeColor);
  return () => mediaQuery.removeEventListener("change", updateThemeColor);
}
