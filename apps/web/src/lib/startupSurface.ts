export type StartupRouteName = "landing" | "invite" | "owner-claim" | "access-claim" | "link-device" | "desktop-verify" | "recover" | "text" | "voice" | "owner";
export type StartupAuthState = "loading" | "ready" | "error";

export function startupSurface(routeName: StartupRouteName, authState: StartupAuthState, desktopLaunch = false) {
  if (authState !== "loading") return "route" as const;
  // Resolve the profile cookie before automatically creating a new Device request.
  if (desktopLaunch && routeName === "link-device") return "shell-skeleton" as const;
  return routeName === "text" || routeName === "voice" || routeName === "owner"
    ? "shell-skeleton" as const
    : "route" as const;
}
