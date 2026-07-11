export type StartupRouteName = "landing" | "invite" | "owner-claim" | "access-claim" | "text" | "voice" | "owner";
export type StartupAuthState = "loading" | "ready" | "error";

export function startupSurface(routeName: StartupRouteName, authState: StartupAuthState) {
  if (authState !== "loading") return "route" as const;
  return routeName === "text" || routeName === "voice" || routeName === "owner"
    ? "shell-skeleton" as const
    : "route" as const;
}
