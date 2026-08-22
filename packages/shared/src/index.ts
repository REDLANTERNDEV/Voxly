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
  /**
   * Where idle members are parked. Exactly one voice room per server carries
   * this, and it is otherwise an ordinary room: it can be renamed, moved, and
   * joined by hand like any other.
   */
  isAfk: boolean;
}

/**
 * How long a member may go without interacting before they are parked.
 *
 * Owner-selected per server rather than global: what counts as away depends on
 * how the room is used, and the person who set the room up is the one who knows.
 */
export const afkTimeoutOptions = [15, 30, 60, 120, 240] as const;
export type AfkTimeoutMinutes = (typeof afkTimeoutOptions)[number];
export const DEFAULT_AFK_TIMEOUT_MINUTES: AfkTimeoutMinutes = 60;

export function isAfkTimeoutMinutes(value: unknown): value is AfkTimeoutMinutes {
  return afkTimeoutOptions.includes(value as AfkTimeoutMinutes);
}

/** Name every server's AFK room is seeded with. Owners may rename it. */
export const afkRoomName = "AFK";

/**
 * Name every server's Music bot account is seeded with. Owners may rename it
 * the same way they rename any other member.
 */
export const musicBotNickname = "Music";

/**
 * Presence beyond connected/disconnected. Offline is the absence of an entry,
 * so only the two present states are named.
 */
export type PresenceStatus = "online" | "idle";

/**
 * The quoted excerpt shown above a reply. Resolved by the server at read time
 * rather than copied at write time, so an edited original is quoted as it now
 * reads and a nickname change follows the same rename path as every other
 * message.
 */
export interface ChatMessageReply {
  messageId: string;
  userId: string;
  nickname: string;
  body: string;
}

/** Longest quoted excerpt the server will send for a reply. */
export const replyExcerptMaxLength = 160;

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  suppressedEmbedKeys: string[];
  /**
   * Present whenever this message was composed as a reply, including when the
   * message it answers has since been deleted. `replyTo` is what distinguishes
   * the two: it is null for a reply whose target is gone.
   */
  replyToMessageId: string | null;
  replyTo: ChatMessageReply | null;
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
  /**
   * Optional for the same reason; an absent status reads as online, so a
   * synthesised entry never claims someone is away.
   */
  status?: PresenceStatus;
  /**
   * A service account rather than a person: it is shown with a Bot marker, left
   * out of member counts, and not offered the moderation actions that only make
   * sense for someone who can be told to leave. Optional like the fields above,
   * and an absent value reads as a person.
   */
  isBot?: boolean;
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

/**
 * How far a peer connection has got through an offer/answer exchange. Spelled
 * out here rather than taken from the DOM so a peer that is not a browser can
 * pass its own library's state through the same rules.
 */
export type VoiceSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";

/**
 * Which of two members offers the connection between them. Comparing user ids
 * gives both sides the same answer without a round trip, so exactly one offer
 * is made however each side first learned the other was there.
 */
export function shouldInitiatePeerConnection(currentUserId: string, peerUserId: string): boolean {
  return currentUserId !== peerUserId && currentUserId < peerUserId;
}

/**
 * What to do with an offer that arrives while this side is making one of its
 * own. The member that the rule above did not pick is the polite one: it drops
 * its own attempt and answers. The other holds its offer and discards the
 * incoming one, so the pair settles on a single exchange rather than cancelling
 * each other out.
 *
 * `makingOffer` covers the window between `createOffer` and
 * `setLocalDescription`, where signaling still reads `stable` although a local
 * offer is already on its way.
 */
export function shouldIgnoreIncomingOffer(
  currentUserId: string,
  peerUserId: string,
  signalingState: VoiceSignalingState,
  makingOffer: boolean
): boolean {
  const hasOfferCollision = makingOffer || signalingState !== "stable";
  const isPolitePeer = currentUserId > peerUserId;
  return hasOfferCollision && !isPolitePeer;
}

/**
 * What a member may ask the Music bot to do in the voice room they are in.
 *
 * One event rather than one per verb, because every one of them is the same
 * request — this room, this instruction — and the transport rules (who may ask,
 * which room, which bot) do not vary between them. The Queue's controls extend
 * this union rather than adding events beside it.
 */
export const musicCommands = ["play", "stop", "leave"] as const;
export type MusicCommand = (typeof musicCommands)[number];

export type MusicControlAck =
  | { ok: true }
  | {
    ok: false;
    /**
     * `no_music_bot` is a server without a bot account; `bot_offline` is an
     * account whose process is not connected. They are distinct because only
     * the second one is worth waiting out.
     */
    error: "room_not_found" | "not_in_voice_room" | "afk_room" | "no_music_bot" | "bot_offline";
  };

export interface ServerToClientEvents {
  "presence:snapshot": (users: PresenceUser[]) => void;
  "presence:online": (user: PresenceUser) => void;
  "presence:offline": (userId: string) => void;
  "presence:serverSnapshot": (snapshot: ServerPresenceSnapshot) => void;
  "presence:serverOnline": (payload: { serverId: string; user: PresenceUser }) => void;
  "presence:serverOffline": (payload: { serverId: string; userId: string }) => void;
  "presence:serverStatus": (payload: { serverId: string; userId: string; status: PresenceStatus }) => void;
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
  /**
   * An owner moved this member to another voice room. The server cannot join
   * for them — the client owns the peer connections — so this is an instruction
   * the recipient carries out through the ordinary join path.
   */
  "voice:moveTo": (payload: { roomId: string }) => void;
  "server:accessRevoked": (payload: { serverId: string; reason: "banned" | "kicked" }) => void;
  "server:directoryChanged": (payload: { serverId: string }) => void;
  "server:memberUpdated": (payload: { serverId: string; user: PresenceUser }) => void;
  "server:updated": (payload: { serverId: string; name: string }) => void;
  "server:afkUpdated": (payload: { serverId: string; afkTimeoutMinutes: AfkTimeoutMinutes }) => void;
  /**
   * A server's room list changed. `deletedRoomId` is present only for a
   * deletion so viewers can move off a room that no longer exists; creation and
   * every other reordering carry no id and are a plain refresh signal.
   */
  "server:roomsChanged": (payload: { serverId: string; deletedRoomId?: string }) => void;
  "server:deleted": (payload: { serverId: string }) => void;
  "rtc:signal": (payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void;
  /**
   * A member asked the Music bot for something. Only ever delivered to that
   * server's bot account: the request has already been authorized against the
   * room by the time it is forwarded, so the bot acts on it rather than
   * re-deciding who was allowed to ask.
   */
  "music:command": (payload: { roomId: string; command: MusicCommand; requestedByUserId: string }) => void;
}

export interface ClientToServerEvents {
  "connection:probe": (ack: () => void) => void;
  "presence:setStatus": (status: PresenceStatus) => void;
  "room:join": (roomId: string) => void;
  "room:leave": (roomId: string) => void;
  "voice:join": (payload: VoiceJoinRequest, ack: (response: VoiceJoinAck) => void) => void;
  "voice:leave": (roomId: string) => void;
  "voice:snapshot": (roomId: string, ack: (snapshot: VoiceSnapshot) => void) => void;
  "voice:setMediaState": (payload: { roomId: string; media: Partial<VoiceMediaState> }, ack: (response: VoiceSetMediaAck) => void) => void;
  "voice:setVisualSubscriptions": (payload: { roomId: string; targets: VisualTarget[] }, ack?: (response: VoiceSetVisualSubscriptionsAck) => void) => void;
  "rtc:signal": (payload: { roomId: string; toUserId: string; signal: RtcSignal }, ack?: (response: RtcSignalAck) => void) => void;
  /**
   * Summon the Music bot, or tell it what to do once it is here. Acknowledged
   * so the asker learns that no bot answered, rather than watching a room where
   * nothing happens.
   */
  "music:control": (payload: { roomId: string; command: MusicCommand }, ack: (response: MusicControlAck) => void) => void;
}
