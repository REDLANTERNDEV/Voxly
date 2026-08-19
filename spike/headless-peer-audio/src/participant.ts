import type { RoomSummary, VoiceMediaState } from "@voxly/shared";
import type { MeshOptions } from "./mesh.js";
import {
  connectSocket,
  fetchIceServers,
  fetchRooms,
  joinVoice,
  pickVoiceRoom,
  signIn,
  silentMedia,
  type Identity,
  type IceServer,
  type VoxlySocket
} from "./voxly.js";

export interface ParticipantOptions {
  baseUrl: string;
  nickname: string;
  inviteToken?: string;
  sessionToken?: string;
  roomName?: string;
  /** What the rest of the room is told this participant is doing. */
  media?: Partial<VoiceMediaState>;
  log?: (message: string) => void;
}

export interface Participant {
  identity: Identity;
  room: RoomSummary;
  socket: VoxlySocket;
  iceServers: IceServer[];
  leave: () => Promise<void>;
}

/** Sign in, find the voice room, connect, and occupy it — the browser's path. */
export async function joinAsParticipant(options: ParticipantOptions): Promise<Participant> {
  const log = options.log ?? (() => undefined);
  const identity = await signIn({
    baseUrl: options.baseUrl,
    inviteToken: options.inviteToken,
    sessionToken: options.sessionToken,
    nickname: options.nickname
  });
  log(`signed in as ${identity.nickname} (${identity.userId})`);

  const [iceServers, rooms] = await Promise.all([
    fetchIceServers(options.baseUrl, identity.sessionToken),
    fetchRooms(options.baseUrl, identity.sessionToken)
  ]);
  const room = pickVoiceRoom(rooms, options.roomName);
  log(`voice room: ${room.name} (${room.id})`);
  log(`ice servers: ${iceServers.map(describeIceServer).join(", ") || "none"}`);

  const socket = await connectSocket(options.baseUrl, identity.sessionToken);
  const ack = await joinVoice(socket, room.id, { ...silentMedia, ...options.media });
  if (!ack.ok) {
    socket.disconnect();
    throw new Error(`voice:join refused: ${ack.error}`);
  }
  log(`joined ${room.name}`);

  return {
    identity,
    room,
    socket,
    iceServers,
    async leave() {
      socket.emit("voice:leave", room.id);
      socket.disconnect();
    }
  };
}

/**
 * Where a participant plugs into the mesh. Four fields that always travel
 * together, so they are handed over as one rather than unpacked at each site.
 */
export function meshFor(participant: Participant): Pick<MeshOptions, "socket" | "roomId" | "selfUserId" | "iceServers"> {
  return {
    socket: participant.socket,
    roomId: participant.room.id,
    selfUserId: participant.identity.userId,
    iceServers: participant.iceServers
  };
}

export function describeIceServer(server: IceServer) {
  const urls = Array.isArray(server.urls) ? server.urls.join("|") : server.urls;
  return server.username ? `${urls} (credentialled)` : urls;
}

export function readEnvironment(defaults: { nickname: string }) {
  const baseUrl = process.env.VOXLY_URL ?? "http://127.0.0.1:3000";
  const inviteToken = process.env.VOXLY_INVITE?.trim() || undefined;
  const sessionToken = process.env.VOXLY_SESSION?.trim() || undefined;
  if (!inviteToken && !sessionToken) {
    throw new Error("Set VOXLY_INVITE to an invite token, or VOXLY_SESSION to a session cookie value");
  }
  return {
    baseUrl,
    inviteToken,
    sessionToken,
    nickname: process.env.VOXLY_NICKNAME?.trim() || defaults.nickname,
    roomName: process.env.VOXLY_ROOM?.trim() || undefined,
    relayOnly: process.env.VOXLY_RELAY === "1"
  };
}
