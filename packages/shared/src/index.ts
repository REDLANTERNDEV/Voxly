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
  /**
   * Put a Track in the Queue, from what a member typed — Summoning the bot if
   * it is not here yet.
   *
   * `input` is a link *or* a name, and which one it is is not decided here.
   * Only the bot knows what a link is worth, so it is the bot that looks: an
   * input naming one Track is added, and an input naming several comes back as
   * Results for the member to choose between (`MusicAnswer`). A second
   * opinion in the browser would be the copy that drifts. ADR-0007.
   */
  | { kind: "add"; input: string }
  | { kind: "play" }
  | { kind: "stop" }
  /**
   * Move past the Track the asker believes is playing, naming it. The entry and
   * not the position, because by the time this arrives the Queue may have moved
   * on: a skip whose target is no longer the head succeeds and advances
   * nothing, which is what makes two members pressing skip together cost one
   * Track rather than two. See ADR-0006.
   */
  | { kind: "skip"; entryId: string }
  /**
   * Take one entry out of the Queue, wherever it is. Naming the entry and not
   * the position for the same reason a skip does — a Track that ended while the
   * request was in flight must not turn a removal into the removal of whatever
   * moved up into its place.
   */
  | { kind: "remove"; entryId: string }
  | { kind: "leave" };

/**
 * The union is the only declaration of the vocabulary — deliberately not a
 * union plus a list of names beside it, because the two would drift and the
 * one that drifted would be a verb one side accepts and the other ignores.
 * Consumers that need to enumerate the verbs derive them from here, and the
 * server asserts at compile time that its validator covers every one.
 */
export type MusicCommandKind = MusicCommand["kind"];

/**
 * The longest input the control plane will carry — a pasted link, a typed name,
 * or the link the browser hands back when a member chooses a search result.
 * Generous; not unbounded. One bound rather than one per kind of string: they
 * arrive on the same field and a second constant beside this one is the one
 * that drifts.
 */
export const musicInputMaxLength = 2_048;

/**
 * The longest Track title the wire will carry. The source chooses the title, so
 * it is somebody else's string arriving unbidden and being relayed to everyone
 * in the room; the link a member typed is bounded and this should be too.
 */
export const musicTitleMaxLength = 200;

/**
 * How many Results a search may answer with.
 *
 * Bounded for the same reason the Queue is: every string in the list is
 * somebody else's, arriving unbidden, and a list of them is that problem
 * several times over. Small on purpose beyond that — the point of the list is
 * to catch the case where the closest match is a cover or an hour-long mix, and
 * five is enough to see that without burying the Queue underneath it.
 */
export const musicSearchResultsMax = 5;

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
 * One Track a search offered, for the member who typed the name to choose
 * between.
 *
 * **This never reaches the room.** It rides back on the acknowledgement to the
 * one socket that asked and goes nowhere near `music:queue`: the Queue is the
 * room's and everyone must see the same one, while a list of Results belongs
 * to the single member who is still deciding. Publishing it would put four
 * people's panels in front of a choice that is not theirs. ADR-0007.
 *
 * `url` is what the browser sends back to play this one — the same `add` a
 * paste would have made. Opaque at that end: the browser stores it and hands it
 * back rather than building a link of its own, and the bot re-reads it exactly
 * as it reads a pasted one, so nothing is trusted for having been round the
 * loop.
 */
export interface MusicSearchResult {
  track: MusicTrackSummary;
  /**
   * Who published it. On the wire because it is what tells a cover from the
   * original, which is half of why a member is being shown a list at all — and
   * it is not on `MusicTrackSummary`, because the Queue does not need it and
   * widening that shape would put it in front of every room.
   */
  channel: string;
  url: string;
}

/**
 * How many Tracks the Queue will hold.
 *
 * A bound rather than a courtesy: the whole Queue is broadcast to everyone in
 * the room on every change, so an unbounded Queue is an unbounded message sent
 * to every Listener. A hundred Tracks is several hours of music, which is more
 * than an evening needs and far less than an accident costs.
 */
export const musicQueueMaxEntries = 100;

/**
 * One Track in the Queue, with the member who put it there.
 *
 * The Requester is an id, not a nickname. The bot knows ids — it is told one
 * with every request and never sees the member list as a person does — while
 * every browser already holds the room's members and renders their current
 * names. A nickname copied onto the wire here would be a second copy of
 * identity the server already publishes, stale from the moment somebody renames
 * themselves.
 */
export interface MusicQueueEntry {
  /**
   * This entry, as distinct from the Track it names. Two members queueing the
   * same link are two entries, and either can be skipped or removed without the
   * other going with it. Stable for as long as the entry is in the Queue, and
   * meaningless outside the Set that produced it.
   */
  entryId: string;
  track: MusicTrackSummary;
  requestedByUserId: string;
}

/**
 * The longest any opaque identifier on the Queue wire may be — an `entryId` the
 * bot minted, a source's own id for a Track, a Requester's user id. One bound
 * rather than three, because they are the same kind of thing to everyone
 * handling them: a short token nobody parses. The server validates against it
 * before the Queue is relayed to a room.
 */
export const musicIdentifierMaxLength = 64;

/**
 * How many lines of the Set log the room is told about.
 *
 * Bounded for the same reason the Queue is, and more urgently: the Queue is
 * bounded because it is broadcast whole on every change, and the log rides the
 * same payload — but a Queue shrinks as Tracks play out and a log only ever
 * grows. Twenty rather than a hundred because the panel owns no scroll region,
 * so every line grows the page for people who are not reading it, and because
 * of what the log is *for*: it explains a silence that has just happened. The
 * line that answers "why did the music change" is one of the last few, and a
 * Set log long enough to need scrolling has stopped answering that question.
 */
export const musicSetLogMaxLines = 20;

/**
 * Why a Track the Queue reached could not be played, as the room is told it.
 *
 * The reason is the verb rather than a field beside one, because the sentence
 * differs all the way through in both languages and a line assembled out of "a
 * Track failed" plus a translated fragment is exactly the fragment-stitching
 * ADR-0008 §5 refuses. One member here is one whole sentence per language, and
 * both are made mandatory by the browser's exhaustive switch.
 *
 * Three rather than two because the third is not a kind of the other two.
 * `failedUnavailable` sends a member to find another Track, `failedSource`
 * sends the room to wait, and `failedBot` sends whoever hosts the server to its
 * logs — and telling a room to wait out an ffmpeg nobody installed is a wait
 * that never ends. They are the three answers `MusicCommandAck` already gives a
 * member whose link would not resolve, said about a Track whose turn came.
 */
export type MusicTrackFailure = "failedUnavailable" | "failedSource" | "failedBot";

/**
 * What happened to the Queue, as one line of the Set log.
 *
 * The five things a member can do that change it, and the three ways a Track
 * can fail once its turn comes. A Track that ends of its own accord is not
 * here: that is the Queue working, and there is nothing to explain. Neither is
 * the Set being torn down — the log does not survive that to describe it.
 *
 * The five name a member and the three do not, which is the one thing every
 * consumer has to read this union for. ADR-0011.
 */
export type MusicSetLogAction =
  | "added"
  | "skipped"
  | "removed"
  | "paused"
  | "resumed"
  | MusicTrackFailure;

/**
 * One line of the Set log: a member, a verb, and the Track it was about.
 *
 * The member is an id, resolved to a nickname at the browser's end — the same
 * rule and the same reason as `MusicQueueEntry.requestedByUserId`, which the
 * browser is already resolving from the same member list. ADR-0005.
 *
 * The Track is a *title* and not an `entryId`, because the point of a line is
 * usually that the entry is gone: "Ada skipped Nocturne" is a sentence about a
 * Track that is no longer in the Queue to be looked up. It carries no time.
 * Order is the list's, identity is `lineId`'s, and a wall-clock instant from
 * the bot's host is not one a member's browser could render honestly.
 */
export interface MusicSetLogLine {
  /**
   * This line, as distinct from any other. Minted per line for the same reason
   * an `entryId` is minted per addition: two members pausing in turn are two
   * lines that are otherwise identical, and the browser needs to tell them
   * apart. Meaningless outside the Set that produced it.
   */
  lineId: string;
  action: MusicSetLogAction;
  /**
   * The member who asked for this, or `null` where nobody did.
   *
   * Null exactly for the three `MusicTrackFailure` verbs, which is the hole
   * ADR-0008 left open and ADR-0011 fills: a Track that will not play is the
   * bot reporting on itself, and there is no member whose name belongs in that
   * sentence. Naming the bot's own account instead would read as somebody
   * having pressed something, in whatever the operator called the account.
   *
   * The type cannot tie the two together and does not try. What keeps it
   * honest is that the failure sentences name no member at all, so a reader
   * never asks this field for one.
   */
  requestedByUserId: string | null;
  /**
   * The Track the action was about, or `null` for a pause or a resume, which
   * are about the Queue rather than about any one Track. Explicitly null rather
   * than absent, as `MusicAnswer`'s `track` is: a consumer that forgets a line
   * may name no Track should be made to say so.
   */
  trackTitle: string | null;
}

/**
 * The Queue and what is happening to it, as everyone in the room sees it.
 *
 * The bot is the single source of truth for this and publishes the whole thing
 * on every change rather than a delta. A room where two members disagree about
 * what is coming next is the failure this contract exists to prevent, and a
 * missed delta is exactly how that happens; the Queue is bounded, so sending
 * all of it costs little.
 */
export interface MusicQueueState {
  /**
   * In playing order. `entries[0]` is the Track the bot is playing or has
   * paused; everything after it is waiting. An empty list is a Set with nothing
   * queued, which is a state the bot really is in — between the last Track
   * ending and the next link being pasted.
   */
  entries: MusicQueueEntry[];
  /**
   * Whether `entries[0]` is being played right now. Separate from the list
   * because a paused Queue is not an empty one.
   */
  playing: boolean;
  /**
   * What members have done to this Queue, most recent first and bounded by
   * `musicSetLogMaxLines`.
   *
   * On this payload rather than beside it, because a line and the change it
   * describes are the same event and two messages could disagree about it — a
   * room told "Ada skipped Nocturne" while still holding Nocturne is exactly
   * the failure the whole-Queue rule above exists to prevent. It costs no extra
   * message either: every line is produced by a change that was already
   * publishing the Queue. ADR-0008 records the choice.
   *
   * The room's, like the entries and unlike a search's Results: everyone must
   * read the same explanation for the same silence.
   */
  log: MusicSetLogLine[];
}

/** What the server answers a bot that published the Queue. */
export type MusicPublishAck =
  | { ok: true }
  | {
    ok: false;
    /**
     * `not_authorized` is a publisher that is not this room's Music bot, or is
     * one that has since left the room — an eviction the bot has not noticed
     * yet arrives this way. `room_not_found` is a room that is gone or was
     * never a voice room. `invalid_state` is a payload that did not survive
     * validation, which is a fault in the bot rather than anything a member
     * did. They are distinct because only the last is a bug.
     */
    error: "not_authorized" | "room_not_found" | "invalid_state";
  };

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
  /** A link to something this bot cannot play: a playlist, a channel, or
   * another site. Only ever a *link* — text that is not one is a name to search
   * for, and an input with nothing in it is a search that found nothing, so
   * this no longer means "that was not a link". */
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
  /** The Queue is full. The link was fine and the bot is fine; there is simply
   * no room for another Track until some of them have played. */
  | "queue_full"
  /** The bot could not carry the request out, for a reason that is not the
   * link's fault — it could not join the channel, or something under it broke.
   * Kept apart from `extractor_failed` because that one sends a member away to
   * wait for YouTube, which would be the wrong thing to wait for. */
  | "bot_failed";

/**
 * What a request that worked produced. The success half of both
 * acknowledgements, so there is one shape for it rather than two that drift.
 *
 * A union, because an `add` has two honest answers and they are not the same
 * size. When the input named one Track it is in the Queue and the Track is
 * reported back; when it named several the bot cannot know which was meant, so
 * it hands back the Results and the member says. Everything else — a pause,
 * a skip, a removal, sending the bot away — is a `track` answer carrying
 * `null`.
 *
 * Discriminated rather than widened with a second optional field. Two nullable
 * fields where exactly one is ever filled is the shape this contract already
 * refused for `MusicCommand`, and it leaves nothing to stop an answer arriving
 * as both or as neither. `kind` is the same discriminant word the command union
 * uses, and the parallel is real: one says what was asked, the other says what
 * came back.
 */
export type MusicAnswer =
  /**
   * `track` is the Track the request produced, or `null` for a request that
   * produces none. Explicitly null rather than absent: a caller that forgets to
   * handle "there is no Track" should be made to say so.
   */
  | { ok: true; kind: "track"; track: MusicTrackSummary | null }
  /**
   * The Results a typed name found, in the source's own order — the first is
   * the closest match and is the one a member is offered first. Possibly empty:
   * a search that ran and matched nothing is an answer rather than a refusal,
   * because nothing failed and there is nothing for the member to wait out.
   */
  | { ok: true; kind: "results"; results: MusicSearchResult[] };

export type MusicControlAck =
  | MusicAnswer
  | { ok: false; error: MusicControlError };

/** What the bot answers the server. The server's own refusals never reach it. */
export type MusicCommandAck =
  | MusicAnswer
  | {
    ok: false;
    error: Extract<
      MusicControlError,
      | "unsupported_link"
      | "track_unavailable"
      | "live_stream"
      | "extractor_failed"
      | "queue_full"
      | "bot_failed"
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
  /**
   * The Queue, as the room's Music bot says it now is. Delivered to everyone in
   * the voice room, so the member who pasted a link and the four people who did
   * not are looking at the same list.
   *
   * It carries the whole Queue rather than what changed. A room where two
   * members disagree about what is coming next is the failure this exists to
   * prevent, and a delta that went missing is exactly how that happens.
   */
  "music:queue": (payload: { roomId: string; state: MusicQueueState }) => void;
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
  /**
   * The Music bot saying what the Queue now is, for the server to hand to
   * everyone in the room.
   *
   * The bot is an ordinary member and cannot emit to a room; this is the one
   * thing it says that reaches more than one person, and the server authorizes
   * it rather than relaying it blind. The publisher must *be* that room's Music
   * bot account and must still be in the room. Nothing here is stored: the bot
   * is the single source of truth and the server is the wire.
   *
   * Acknowledged so a bot publishing into a room it has been evicted from
   * learns that, rather than believing a Queue nobody can see.
   */
  "music:publish": (
    payload: { roomId: string; state: MusicQueueState },
    ack?: (response: MusicPublishAck) => void
  ) => void;
}
