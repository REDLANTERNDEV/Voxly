import type { RoomSummary } from "@voxly/shared";

export interface InitialRouteInput {
  isAuthenticated: boolean;
  inviteToken: string | null;
}

export type PathRoute =
  | { name: "landing" }
  | { name: "invite"; token: string }
  | { name: "owner-claim" }
  | { name: "access-claim"; token: string }
  | { name: "text"; serverId: string; roomId: string }
  | { name: "voice"; serverId: string; roomId: string }
  | { name: "owner"; serverId: string };

export const defaultServerId = "the-basement";

export function firstServerRoomPath(serverId: string, rooms: RoomSummary[]) {
  const target = rooms.find((room) => room.kind === "text") ?? rooms[0];
  return target
    ? `/app/server/${encodeURIComponent(serverId)}/${target.kind}/${encodeURIComponent(target.id)}`
    : "/";
}

export function resolveInitialRoute(input: InitialRouteInput) {
  if (input.isAuthenticated) {
    return `/app/server/${defaultServerId}/text/general`;
  }

  if (input.inviteToken) {
    return `/invite/${encodeURIComponent(input.inviteToken)}`;
  }

  return "/";
}

export function parsePathRoute(pathname: string): PathRoute {
  if (pathname === "/") return { name: "landing" };
  if (pathname === "/invite") return { name: "invite", token: "" };
  if (pathname.startsWith("/owner")) return { name: "owner", serverId: defaultServerId };
  if (pathname === "/setup/owner") return { name: "owner-claim" };
  if (pathname === "/access/claim") return { name: "access-claim", token: getAccessClaimTokenFromHash(window.location.hash) };
  const serverRoute = pathname.match(/^\/app\/server\/([^/]+)\/(text|voice)\/([^/]+)$/);
  if (serverRoute) {
    return {
      name: serverRoute[2] as "text" | "voice",
      serverId: decodeURIComponent(serverRoute[1]),
      roomId: decodeURIComponent(serverRoute[3])
    };
  }
  const ownerRoute = pathname.match(/^\/app\/server\/([^/]+)\/owner$/);
  if (ownerRoute) return { name: "owner", serverId: decodeURIComponent(ownerRoute[1]) };
  if (pathname.startsWith("/app/voice/")) return { name: "voice", serverId: defaultServerId, roomId: decodeURIComponent(pathname.slice("/app/voice/".length)) || "lobby" };
  if (pathname.startsWith("/app/text/")) return { name: "text", serverId: defaultServerId, roomId: decodeURIComponent(pathname.slice("/app/text/".length)) || "general" };
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

export function getAccessClaimTokenFromHash(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.get("token") ?? "";
}
