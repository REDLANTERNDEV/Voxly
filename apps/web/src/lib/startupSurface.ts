export type StartupRouteName =
  | "landing"
  | "invite"
  | "owner-claim"
  | "access-claim"
  | "link-device"
  | "desktop-verify"
  | "recover"
  | "text"
  | "voice"
  | "owner";
export type StartupAuthState = "loading" | "ready" | "error";

export function startupSurface(routeName: StartupRouteName, authState: StartupAuthState, desktopLaunch = false) {
  if (authState !== "loading") return "route" as const;
  return routeName === "text" ||
    routeName === "voice" ||
    routeName === "owner" ||
    (desktopLaunch && routeName === "link-device")
    ? ("shell-skeleton" as const)
    : ("entry-loading" as const);
}

/** Native startup may reveal a usable route, including a recoverable error, but never the bootstrap skeleton. */
export function desktopSurfaceReady({
  routeName,
  authState,
  desktopLaunch,
  existingDesktopSession,
  authenticated,
  rtcConfigReady,
  workspaceReady = true,
  workspaceError = false
}: {
  routeName: StartupRouteName;
  authState: StartupAuthState;
  desktopLaunch: boolean;
  existingDesktopSession: boolean;
  authenticated: boolean;
  rtcConfigReady: boolean;
  workspaceReady?: boolean;
  workspaceError?: boolean;
}): boolean {
  const protectedRoute = routeName === "text" || routeName === "voice" || routeName === "owner";
  return (
    authState !== "loading" &&
    !existingDesktopSession &&
    startupSurface(routeName, authState, desktopLaunch) !== "shell-skeleton" &&
    !(
      authenticated &&
      (protectedRoute || routeName === "landing") &&
      (!rtcConfigReady || !workspaceReady) &&
      !workspaceError &&
      authState !== "error"
    )
  );
}
