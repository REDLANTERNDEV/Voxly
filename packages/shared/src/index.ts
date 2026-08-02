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
  serverId: string;
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
  suppressedEmbedKeys: string[];
}

export interface PresenceUser {
  userId: string;
  nickname: string;
  role: UserRole;
  /**
   * Per-server grant that lets a plain member create invites. Optional because
   * presence objects synthesised from the local session have no server context.
   */
  canInvite?: boolean;
}

export interface ServerPresenceSnapshot {
  serverId: string;
  users: PresenceUser[];
}

export interface VoiceMediaState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
  deafened: boolean;
  speaking: boolean;
}

export interface VoiceModerationState {
  muted: boolean;
  deafened: boolean;
}

export interface VoiceMemberState {
  user: PresenceUser;
  media: VoiceMediaState;
  moderation: VoiceModerationState;
}

export interface VoiceJoinRequest {
  roomId: string;
  media: VoiceMediaState;
}

export type VoiceJoinAck =
  | { ok: true; state: VoiceMemberState }
  | { ok: false; error: "room_not_found" | "forbidden" | "visual_limit_reached" };

export type VoiceSetMediaAck =
  | { ok: true; state: VoiceMemberState }
  | { ok: false; error: "not_in_voice_room" | "visual_limit_reached" | "room_not_found" };

export interface VoiceSnapshot {
  roomId: string;
  members: VoiceMemberState[];
}

export type VoiceForceLeaveReason = "joined_another_room" | "owner_disconnect" | "server_access_revoked" | "room_deleted" | "server_deleted";

export type VisualMediaKind = "camera" | "screen";

export interface VisualTarget {
  publisherUserId: string;
  kind: VisualMediaKind;
}

export type VoiceSetVisualSubscriptionsAck =
  | { ok: true; targets: VisualTarget[] }
  | {
    ok: false;
    error: "invalid_payload" | "room_not_found" | "not_in_voice_room" | "target_not_in_voice_room" | "target_visual_unavailable";
  };

export type RtcSignal = Record<string, unknown>;

export type RtcSignalAck =
  | { ok: true }
  | { ok: false; error: "room_not_found" | "not_in_voice_room" | "target_not_in_voice_room" };

export interface ServerToClientEvents {
  "presence:snapshot": (users: PresenceUser[]) => void;
  "presence:online": (user: PresenceUser) => void;
  "presence:offline": (userId: string) => void;
  "presence:serverSnapshot": (snapshot: ServerPresenceSnapshot) => void;
  "presence:serverOnline": (payload: { serverId: string; user: PresenceUser }) => void;
  "presence:serverOffline": (payload: { serverId: string; userId: string }) => void;
  "message:new": (message: ChatMessage) => void;
  "message:updated": (message: ChatMessage) => void;
  "message:deleted": (payload: { roomId: string; messageId: string }) => void;
  "voice:joined": (payload: { roomId: string; user: PresenceUser }) => void;
  "voice:left": (payload: { roomId: string; userId: string }) => void;
  "voice:snapshot": (snapshot: VoiceSnapshot) => void;
  "voice:visualSubscriberState": (payload: {
    roomId: string;
    viewerUserId: string;
    subscribedKinds: VisualMediaKind[];
  }) => void;
  "voice:forceLeave": (payload: { roomId: string; reason: VoiceForceLeaveReason }) => void;
  "server:accessRevoked": (payload: { serverId: string; reason: "banned" | "kicked" }) => void;
  "server:directoryChanged": (payload: { serverId: string }) => void;
  "server:memberUpdated": (payload: { serverId: string; user: PresenceUser }) => void;
  "server:updated": (payload: { serverId: string; name: string }) => void;
  "server:roomsChanged": (payload: { serverId: string; deletedRoomId: string }) => void;
  "server:deleted": (payload: { serverId: string }) => void;
  "rtc:signal": (payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void;
}

export interface ClientToServerEvents {
  "connection:probe": (ack: () => void) => void;
  "room:join": (roomId: string) => void;
  "room:leave": (roomId: string) => void;
  "voice:join": (payload: VoiceJoinRequest, ack: (response: VoiceJoinAck) => void) => void;
  "voice:leave": (roomId: string) => void;
  "voice:snapshot": (roomId: string, ack: (snapshot: VoiceSnapshot) => void) => void;
  "voice:setMediaState": (payload: { roomId: string; media: Partial<VoiceMediaState> }, ack: (response: VoiceSetMediaAck) => void) => void;
  "voice:setVisualSubscriptions": (payload: { roomId: string; targets: VisualTarget[] }, ack?: (response: VoiceSetVisualSubscriptionsAck) => void) => void;
  "rtc:signal": (payload: { roomId: string; toUserId: string; signal: RtcSignal }, ack?: (response: RtcSignalAck) => void) => void;
}
