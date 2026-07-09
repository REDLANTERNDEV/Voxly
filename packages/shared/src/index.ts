export type UserRole = "owner" | "member";

export type RoomKind = "text" | "voice";

export interface PublicUser {
  id: string;
  nickname: string;
  role: UserRole;
  bannedAt: string | null;
}

export interface RoomSummary {
  id: string;
  name: string;
  kind: RoomKind;
  position: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface PresenceUser {
  userId: string;
  nickname: string;
  role: UserRole;
}

export interface VoiceMediaState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
  deafened: boolean;
  speaking: boolean;
}

export interface VoiceMemberState {
  user: PresenceUser;
  media: VoiceMediaState;
}

export type VoiceSetMediaAck =
  | { ok: true; state: VoiceMemberState }
  | { ok: false; error: "not_in_voice_room" | "visual_limit_reached" | "room_not_found" };

export interface VoiceSnapshot {
  roomId: string;
  members: VoiceMemberState[];
}

export type RtcSignal = Record<string, unknown>;

export type RtcSignalAck =
  | { ok: true }
  | { ok: false; error: "room_not_found" | "not_in_voice_room" | "target_not_in_voice_room" };

export interface ServerToClientEvents {
  "presence:snapshot": (users: PresenceUser[]) => void;
  "presence:online": (user: PresenceUser) => void;
  "presence:offline": (userId: string) => void;
  "message:new": (message: ChatMessage) => void;
  "message:updated": (message: ChatMessage) => void;
  "message:deleted": (payload: { roomId: string; messageId: string }) => void;
  "voice:joined": (payload: { roomId: string; user: PresenceUser }) => void;
  "voice:left": (payload: { roomId: string; userId: string }) => void;
  "voice:snapshot": (snapshot: VoiceSnapshot) => void;
  "rtc:signal": (payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void;
}

export interface ClientToServerEvents {
  "room:join": (roomId: string) => void;
  "room:leave": (roomId: string) => void;
  "voice:join": (roomId: string) => void;
  "voice:leave": (roomId: string) => void;
  "voice:snapshot": (roomId: string, ack: (snapshot: VoiceSnapshot) => void) => void;
  "voice:setMediaState": (payload: { roomId: string; media: Partial<VoiceMediaState> }, ack: (response: VoiceSetMediaAck) => void) => void;
  "rtc:signal": (payload: { roomId: string; toUserId: string; signal: RtcSignal }, ack?: (response: RtcSignalAck) => void) => void;
}
