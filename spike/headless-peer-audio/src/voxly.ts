import type {
  ClientToServerEvents,
  RoomSummary,
  ServerToClientEvents,
  VoiceJoinAck,
  VoiceMediaState
} from "@voxly/shared";
import { io, type Socket } from "socket.io-client";

/**
 * The parts of Voxly a headless peer needs. Everything here goes through the
 * same public HTTP and Socket.IO surface a browser uses — no database, no
 * private endpoint — because that is what the real bot will be allowed to do.
 */

export const sessionCookieName = "voxly_session";

export interface Identity {
  userId: string;
  nickname: string;
  sessionToken: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Typed against the shared event maps, so a contract change breaks the build
 *  here rather than going silent on the wire. */
export type VoxlySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SignInOptions {
  baseUrl: string;
  /** An invite from the server owner. The bot becomes an ordinary member. */
  inviteToken?: string;
  /** Or an existing session cookie value, for a bot that already has an account. */
  sessionToken?: string;
  nickname: string;
}

export async function signIn({ baseUrl, inviteToken, sessionToken, nickname }: SignInOptions): Promise<Identity> {
  if (sessionToken) {
    const user = await getJson<{ user: { id: string; nickname: string } }>(baseUrl, "/api/me", sessionToken);
    return { userId: user.user.id, nickname: user.user.nickname, sessionToken };
  }
  if (!inviteToken) {
    throw new Error("Pass either an invite token or a session token");
  }

  const response = await fetch(new URL("/api/invites/accept", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteToken, nickname })
  });
  if (!response.ok) {
    throw new Error(`Invite rejected: ${response.status} ${await response.text()}`);
  }

  const token = sessionTokenFrom(response);
  const body = (await response.json()) as { user: { id: string; nickname: string } };
  return { userId: body.user.id, nickname: body.user.nickname, sessionToken: token };
}

export async function fetchIceServers(baseUrl: string, sessionToken: string) {
  const config = await getJson<{ iceServers: IceServer[] }>(baseUrl, "/api/rtc/config", sessionToken);
  return config.iceServers ?? [];
}

export async function fetchRooms(baseUrl: string, sessionToken: string) {
  const rooms = await getJson<{ rooms: RoomSummary[] }>(baseUrl, "/api/rooms", sessionToken);
  return rooms.rooms;
}

/**
 * The voice room to play into: the one named, or the first that is not the AFK
 * room — a bot parked in AFK is muted by the server and would prove nothing.
 */
export function pickVoiceRoom(rooms: RoomSummary[], name?: string) {
  const voiceRooms = rooms.filter((room) => room.kind === "voice");
  const room = name
    ? voiceRooms.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() || candidate.id === name)
    : voiceRooms.find((candidate) => !candidate.isAfk);
  if (!room) {
    throw new Error(name ? `No voice room called ${name}` : "This server has no non-AFK voice room");
  }
  return room;
}

export function connectSocket(baseUrl: string, sessionToken: string): Promise<VoxlySocket> {
  return new Promise((resolve, reject) => {
    const socket: VoxlySocket = io(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { cookie: `${sessionCookieName}=${sessionToken}` },
      reconnection: false
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error: Error) => {
      socket.disconnect();
      reject(new Error(`Voxly refused the socket: ${error.message}`));
    });
  });
}

export const silentMedia: VoiceMediaState = {
  mic: false,
  camera: false,
  screen: false,
  deafened: false,
  speaking: false
};

export function joinVoice(socket: VoxlySocket, roomId: string, media: VoiceMediaState) {
  return new Promise<VoiceJoinAck>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("voice:join was never acknowledged")), 5_000);
    socket.emit("voice:join", { roomId, media }, (ack) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

export async function getJson<T>(baseUrl: string, path: string, sessionToken: string): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    headers: { cookie: `${sessionCookieName}=${sessionToken}` }
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** Voxly returns the raw session token once, in a Set-Cookie header. */
export function sessionTokenFrom(response: Response) {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0 && pair.slice(0, separator).trim() === sessionCookieName) {
      return decodeURIComponent(pair.slice(separator + 1));
    }
  }
  throw new Error("Voxly accepted the invite but set no session cookie");
}
