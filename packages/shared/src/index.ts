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
 *
 * A discriminated union rather than a bare string, because `add` carries the
 * link it names and the others carry nothing. The alternative — one string plus
 * an optional `url` — would make the field optional everywhere in order to be
 * absent in three cases out of four, and nothing would stop a `stop` arriving
 * with a link on it.
 */
export type MusicCommand =
  /** Play what this link points at, Summoning the bot if it is not here yet. */
  | { kind: "add"; url: string }
  | { kind: "play" }
  | { kind: "stop" }
  | { kind: "leave" };

/**
 * The union is the only declaration of the vocabulary — deliberately not a
 * union plus a list of names beside it, because the two would drift and the
 * one that drifted would be a verb one side accepts and the other ignores.
 * Consumers that need to enumerate the verbs derive them from here, and the
 * server asserts at compile time that its validator covers every one.
 */
export type MusicCommandKind = MusicCommand["kind"];

/** The longest link the control plane will carry. Generous; not unbounded. */
export const musicLinkMaxLength = 2_048;

/**
 * The longest Track title the wire will carry. The source chooses the title, so
 * it is somebody else's string arriving unbidden and being relayed to everyone
 * in the room; the link a member typed is bounded and this should be too.
 */
export const musicTitleMaxLength = 200;

/**
 * A Track, as much of it as anyone outside the bot needs to name it. The bot
 * knows more — the stream it came from, how to fetch it again — and none of
 * that belongs on the wire.
 */
export interface MusicTrackSummary {
  /** The source's own identity for it, stable across two people pasting it. */
  id: string;
  title: string;
  durationSeconds: number;
}

/**
 * Why a music request could not be carried out.
 *
 * The first five are the server's answer and are known before the bot is
 * involved at all. The rest are the bot's, relayed back through the same
 * acknowledgement, because the alternative for a member who pasted a dead link
 * is silence — and silence is the worst possible answer from a control whose
 * only output is sound somewhere else.
 */
export type MusicControlError =
  /** `no_music_bot` is a server without a bot account; `bot_offline` is an
   * account whose process is not connected. They are distinct because only the
   * second one is worth waiting out. */
  | "room_not_found"
  | "not_in_voice_room"
  | "afk_room"
  | "no_music_bot"
  | "bot_offline"
  /** Not a link to something this bot can play: a playlist, a channel, another
   * site, or not a link at all. */
  | "unsupported_link"
  /** A real video that will not play: private, deleted, blocked, or age-gated. */
  | "track_unavailable"
  /** A broadcast rather than a Track. It has no end, so it cannot be queued. */
  | "live_stream"
  /** The extractor itself failed — missing, crashed, or being refused by the
   * source. Distinct from the two above because nothing about the link is
   * wrong and trying again later may well work. */
  | "extractor_failed"
  /** The bot has the request and has not answered. Distinct from `bot_offline`:
   * something is running, it is just not finishing. */
  | "bot_timeout"
  /** The bot could not carry the request out, for a reason that is not the
   * link's fault — it could not join the channel, or something under it broke.
   * Kept apart from `extractor_failed` because that one sends a member away to
   * wait for YouTube, which would be the wrong thing to wait for. */
  | "bot_failed";

export type MusicControlAck =
  /**
   * `track` is the Track the request produced, or `null` for a request that
   * produces none. Explicitly null rather than absent: a caller that forgets to
   * handle "there is no Track" should be made to say so.
   */
  | { ok: true; track: MusicTrackSummary | null }
  | { ok: false; error: MusicControlError };

/** What the bot answers the server. The server's own refusals never reach it. */
export type MusicCommandAck =
  | { ok: true; track: MusicTrackSummary | null }
  | {
    ok: false;
    error: Extract<
      MusicControlError,
      "unsupported_link" | "track_unavailable" | "live_stream" | "extractor_failed" | "bot_failed"
    >;
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
   *
   * Acknowledged, because only the bot can tell whether a pasted link is
   * playable, and the member who pasted it is owed that answer rather than a
   * room where nothing happens.
   */
  "music:command": (
    payload: { roomId: string; command: MusicCommand; requestedByUserId: string },
    ack: (response: MusicCommandAck) => void
  ) => void;
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
