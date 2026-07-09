export interface InitialRouteInput {
  isAuthenticated: boolean;
  inviteToken: string | null;
}

export type PathRoute =
  | { name: "landing" }
  | { name: "invite"; token: string }
  | { name: "owner-claim" }
  | { name: "text"; roomId: string }
  | { name: "voice"; roomId: string }
  | { name: "owner" };

export function resolveInitialRoute(input: InitialRouteInput) {
  if (input.isAuthenticated) {
    return "/app/text/general";
  }

  if (input.inviteToken) {
    return `/invite/${encodeURIComponent(input.inviteToken)}`;
  }

  return "/";
}

export function parsePathRoute(pathname: string): PathRoute {
  if (pathname === "/") return { name: "landing" };
  if (pathname === "/invite") return { name: "invite", token: "" };
  if (pathname.startsWith("/owner")) return { name: "owner" };
  if (pathname === "/setup/owner") return { name: "owner-claim" };
  if (pathname.startsWith("/app/voice/")) return { name: "voice", roomId: decodeURIComponent(pathname.slice("/app/voice/".length)) || "lobby" };
  if (pathname.startsWith("/app/text/")) return { name: "text", roomId: decodeURIComponent(pathname.slice("/app/text/".length)) || "general" };
  if (pathname.startsWith("/invite/")) return { name: "invite", token: getInviteTokenFromPath(pathname) };
  return { name: "landing" };
}

export function getInviteTokenFromPath(pathname: string) {
  const match = pathname.match(/^\/invite\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function getOwnerClaimTokenFromHash(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.get("claim") ?? "";
}
