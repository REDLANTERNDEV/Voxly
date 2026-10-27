export type UserRole = "owner" | "member";

export type RoomKind = "text" | "voice";

export interface PublicUser {
  id: string;
  nickname: string;
  role: UserRole;
  bannedAt: string | null;
}

/**
 * One browser holding one session for a member, as that member sees it
 * (`CONTEXT.md` — Devices and access).
 *
 * `label` is coarse and derived — "Chrome on Windows" — never the raw
 * User-Agent. The member only needs to tell their own Devices apart, and a
 * fingerprint would be a privacy cost with no matching benefit.
 */
export interface DeviceSummary {
  id: string;
  label: string;
  /**
   * How this Device arrived. A Device that appeared by Recovery is a very
   * different event from one somebody linked while holding both, and "was that
   * me?" is much easier to answer when the list says which.
   */
  origin: "invite" | "link" | "recovery";
  createdAt: string;
  lastSeenAt: string | null;
  /** The Device asking. It is the one thing a member may not sign out here. */
  current: boolean;
}

export interface RoomSummary {
  id: string;
  serverId: string;
  name: string;
  kind: RoomKind;
  position: number;
  categoryId: string | null;
  /**
   * Where idle members are parked. Exactly one voice room per server carries
   * this, and it is otherwise an ordinary room: it can be renamed, moved, and
   * joined by hand like any other.
   */
  isAfk: boolean;
}

/** A server-wide group of text and voice rooms. */
export interface CategorySummary {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

/** The complete, server-scoped order used for one atomic room layout change. */
export interface ServerRoomLayout {
  groups: Array<{ categoryId: string | null; roomIds: string[] }>;
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
 * Whether a member joining through an invite gets a Welcome notice, and where.
 * On by default. A null room means the server's top text channel, which is
 * also where a notice goes once the chosen channel is deleted.
 */
export interface ServerWelcomeSettings {
  welcomeNotices: boolean;
  welcomeRoomId: string | null;
}

/**
 * Name every server's Music bot account is seeded with. Owners may rename it
 * the same way they rename any other member.
 */
export const musicBotNickname = "Music";

/**
 * Presence beyond connected/disconnected, as other members see it. Offline is
 * the absence of an entry, so only the present states are named. Invisible is
 * not among them: an invisible member is absent from the list exactly like an
 * offline one, so the wire never says who is hiding.
 */
export type PresenceStatus = "online" | "idle" | "dnd";

/**
 * The Status a member picked for themselves. Unlike Presence it is held per
 * account, so every tab and Device agrees, and it is only ever sent back to
 * that member.
 */
export type PresenceChoice = "online" | "idle" | "dnd" | "invisible";
export const presenceDurationOptions = [15, 60, 480, 1440, 4320] as const;
export type PresenceDurationMinutes = (typeof presenceDurationOptions)[number];
export type PresenceChoiceRequest =
  | { status: "online" }
  | {
      status: Exclude<PresenceChoice, "online">;
      duration: { mode: "timed"; durationMinutes: PresenceDurationMinutes } | { mode: "indefinite" };
    };
/** A null `until` means the Status lasts until the member changes it. */
export interface PresenceChoiceState {
  status: PresenceChoice;
  until: string | null;
}

export function isPresenceChoiceRequest(value: unknown): value is PresenceChoiceRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as { status?: unknown; duration?: unknown };
  if (request.status === "online") return true;
  if (request.status !== "idle" && request.status !== "dnd" && request.status !== "invisible") return false;
  if (typeof request.duration !== "object" || request.duration === null) return false;
  const duration = request.duration as { mode?: unknown; durationMinutes?: unknown };
  if (duration.mode === "indefinite") return true;
  return (
    duration.mode === "timed" && presenceDurationOptions.includes(duration.durationMinutes as PresenceDurationMinutes)
  );
}

/**
 * The quoted excerpt shown above a reply. Resolved by the server at read time
 * rather than copied at write time, so an edited original is quoted as it now
 * reads and a nickname change follows the same rename path as every other
 * message.
 */
export interface ChatMessageReply {
  kind: ChatMessageKind;
  messageId: string;
  userId: string;
  nickname: string;
  authorDeleted: boolean;
  body: string;
  mentions: MessageMention[];
}

/** Longest quoted excerpt the server will send for a reply. */
export const replyExcerptMaxLength = 160;

/**
 * A `memberJoined` row is a Welcome notice: the server posts it, in the name of
 * the member who joined, with an empty body. Each client words it in its own
 * language, so nothing translated is stored.
 */
export type ChatMessageKind = "message" | "memberJoined";

/** What waving at a Welcome notice posts, as a reply to it. */
export const welcomeWaveBody = "👋";

export interface ChatMessage {
  kind: ChatMessageKind;
  mentions: MessageMention[];
  reactionState: MessageReactionState;
  pinnedAt: string | null;
  serverId: string;
  sequence: number;
  id: string;
  roomId: string;
  userId: string;
  nickname: string;
  authorDeleted: boolean;
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
  /** Absent only on synthesized session identities with no Server context. */
  mentionCode?: string;
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
  /** Public, ephemeral identity of the member's live media runtime, never an auth token. */
  mediaInstanceId?: string;
  user: PresenceUser;
  media: VoiceMediaState;
  moderation: VoiceModerationState;
}

export interface VoiceJoinRequest {
  /** Stable over signalling reconnects; replaced when the media runtime is recreated. */
  mediaInstanceId?: string;
  roomId: string;
  media: VoiceMediaState;
}

export type VoiceJoinAck =
  { ok: true; state: VoiceMemberState } | { ok: false; error: "room_not_found" | "forbidden" | "visual_limit_reached" };

export type VoiceSetMediaAck =
  | { ok: true; state: VoiceMemberState }
  | { ok: false; error: "not_in_voice_room" | "visual_limit_reached" | "room_not_found" };

export interface VoiceSnapshot {
  roomId: string;
  /** Whether the server delivered this snapshot to a socket currently in the room. */
  viewerInVoiceRoom: boolean;
  members: VoiceMemberState[];
}

/**
 * Why a member stopped being in a voice room without asking to be.
 *
 * `joined_another_device` is the one that is not a fault: the same member
 * joined from a second Device, and voice follows the newest one. It is listed
 * with the rest because the client's handling is identical — tear down and
 * leave — but the copy for it must not read as an error, because nothing went
 * wrong (ADR-0014).
 */
export type VoiceForceLeaveReason =
  | "joined_another_room"
  | "joined_another_device"
  | "owner_disconnect"
  | "server_access_revoked"
  | "room_deleted"
  | "socket_disconnect"
  | "server_deleted";

export type VisualMediaKind = "camera" | "screen";

export interface VisualTarget {
  publisherUserId: string;
  kind: VisualMediaKind;
}

export type VoiceSetVisualSubscriptionsAck =
  | { ok: true; targets: VisualTarget[] }
  | {
      ok: false;
      error:
        | "invalid_payload"
        | "room_not_found"
        | "not_in_voice_room"
        | "target_not_in_voice_room"
        | "target_visual_unavailable";
    };

export type RtcSignal = Record<string, unknown>;

/** A request for the deterministic offerer to refresh this peer's ICE path. */
export interface RtcRecoveryRequest {
  type: "recovery-request";
}

export function isRtcRecoveryRequest(signal: unknown): signal is RtcRecoveryRequest {
  return (
    typeof signal === "object" &&
    signal !== null &&
    (signal as { type?: unknown }).type === "recovery-request" &&
    Object.keys(signal).length === 1
  );
}

export type RtcSignalAck =
  { ok: true } | { ok: false; error: "room_not_found" | "not_in_voice_room" | "target_not_in_voice_room" };

/**
 * How far a peer connection has got through an offer/answer exchange. Spelled
 * out here rather than taken from the DOM so a peer that is not a browser can
 * pass its own library's state through the same rules.
 */
export type VoiceSignalingState =
  "stable" | "have-local-offer" | "have-remote-offer" | "have-local-pranswer" | "have-remote-pranswer" | "closed";

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
 * The longest Track the bot will play, in seconds. The bot keeps every encoded
 * frame of the Track that is playing, in one process that serves every server,
 * so length is a memory bound rather than a taste: two hours is about 120 MB of
 * buffered audio against the bot container's default 320 MB limit.
 */
export const musicTrackMaxSeconds = 2 * 60 * 60;

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
export type MusicSetLogAction = "added" | "skipped" | "removed" | "paused" | "resumed" | MusicTrackFailure;

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
  /** A Track longer than `musicTrackMaxSeconds`, which the bot will not hold. */
  | "track_too_long"
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

export type MusicControlAck = MusicAnswer | { ok: false; error: MusicControlError };

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
        | "track_too_long"
        | "extractor_failed"
        | "queue_full"
        | "bot_failed"
      >;
    };

export interface ServerToClientEvents {
  "account:deleted": (payload: { reason: "request_approved" | "owner_initiated" }) => void;
  "account:deletionRequestCreated": (payload: { requestId: string }) => void;
  /** The member's own Status. Sent only to that member's sockets. */
  "presence:choice": (state: PresenceChoiceState) => void;
  "presence:serverSnapshot": (snapshot: ServerPresenceSnapshot) => void;
  "presence:serverOnline": (payload: { serverId: string; user: PresenceUser }) => void;
  "presence:serverOffline": (payload: { serverId: string; userId: string }) => void;
  "presence:serverStatus": (payload: { serverId: string; userId: string; status: PresenceStatus }) => void;
  "notifications:changed": (event: { serverId: string }) => void;
  "message:new": (message: ChatMessage) => void;
  "message:updated": (message: ChatMessage) => void;
  "message:reactions": (event: MessageReactionsEvent) => void;
  "message:pinsChanged": (event: { serverId: string; roomId: string }) => void;
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
  "server:memberDeleted": (payload: { serverId: string; userId: string }) => void;
  "server:updated": (payload: { serverId: string; name: string }) => void;
  "server:afkUpdated": (payload: { serverId: string; afkTimeoutMinutes: AfkTimeoutMinutes }) => void;
  "server:welcomeUpdated": (payload: ServerWelcomeSettings & { serverId: string }) => void;
  /**
   * A server's room list changed. `deletedRoomId` is present only for a
   * deletion so viewers can move off a room that no longer exists; creation and
   * every other reordering carry no id and are a plain refresh signal.
   */
  "server:roomsChanged": (payload: { serverId: string; deletedRoomId?: string }) => void;
  "server:deleted": (payload: { serverId: string }) => void;
  "rtc:signal": (payload: { roomId: string; fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => void;
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
   * Signals connected bot sockets that server provisioning has changed (a server was created or deleted),
   * allowing the bot to incrementally synchronize its accounts without dropping healthy connections.
   */
  "bot:resync": () => void;
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
  /** What this connection measured; only online and idle are accepted. */
  "presence:setStatus": (status: PresenceStatus) => void;
  "presence:setChoice": (
    request: PresenceChoiceRequest,
    ack: (response: { ok: true; state: PresenceChoiceState } | { ok: false }) => void
  ) => void;
  "room:join": (roomId: string) => void;
  "room:leave": (roomId: string) => void;
  "voice:join": (payload: VoiceJoinRequest, ack: (response: VoiceJoinAck) => void) => void;
  "voice:leave": (roomId: string) => void;
  "voice:snapshot": (roomId: string, ack: (snapshot: VoiceSnapshot) => void) => void;
  "voice:setMediaState": (
    payload: { roomId: string; media: Partial<VoiceMediaState> },
    ack: (response: VoiceSetMediaAck) => void
  ) => void;
  "voice:setVisualSubscriptions": (
    payload: { roomId: string; targets: VisualTarget[] },
    ack?: (response: VoiceSetVisualSubscriptionsAck) => void
  ) => void;
  "rtc:signal": (
    payload: { roomId: string; toUserId: string; signal: RtcSignal },
    ack?: (response: RtcSignalAck) => void
  ) => void;
  /**
   * Summon the Music bot, or tell it what to do once it is here. Acknowledged
   * so the asker learns that no bot answered, rather than watching a room where
   * nothing happens.
   */
  "music:control": (
    payload: { roomId: string; command: MusicCommand },
    ack: (response: MusicControlAck) => void
  ) => void;
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

/** Personal message notifications; unrelated to owner-enforced voice moderation. */
export type ServerNotificationMute = { mode: "enabled" } | { mode: "until"; until: string } | { mode: "indefinite" };
export type NotificationMuteRequest =
  { mode: "enabled" } | { mode: "timed"; durationMinutes: 15 | 60 | 180 | 480 | 1440 } | { mode: "indefinite" };
export interface RoomUnreadState {
  roomId: string;
  unreadCount: number;
  lastReadSequence: number;
  latestSequence: number;
}
export interface ServerNotificationState {
  serverId: string;
  mute: ServerNotificationMute;
  rooms: RoomUnreadState[];
}
export interface NotificationStateResponse {
  serverTime: string;
  servers: ServerNotificationState[];
}

/**
 * Local Unicode catalogue shared by the picker and server reaction allowlist.
 *
 * Every entry is a fully-qualified RGI emoji that Windows 10 and macOS both
 * draw, which leaves out two things on purpose: flags, which Windows renders as
 * two letters (and the desktop app runs on Windows), and skin-tone variants,
 * which would multiply the allowlist. Each line is `emoji|English|Turkish`, the
 * words the picker's search matches in either language.
 */
export const chatEmojiGroups = [
  "faces",
  "gestures",
  "nature",
  "food",
  "activities",
  "travel",
  "objects",
  "symbols"
] as const;
export type ChatEmojiGroup = (typeof chatEmojiGroups)[number];
export type ChatEmojiEntry = readonly [emoji: string, group: ChatEmojiGroup, en: string, tr: string];

const chatEmojiSource: Record<ChatEmojiGroup, string> = {
  faces: `
😀|grin smile happy|gülümse mutlu
😃|happy smile|mutlu gülümse
😄|laugh happy|gül mutlu
😁|grin|gülümse
😆|laugh|kahkaha
😂|laugh tears|kahkaha gözyaşı
🤣|laugh rolling|kahkaha
😊|smile blush|gülümse utan
😉|wink|göz kırp
😍|love heart eyes|aşk sevgi
🥰|love hearts|sevgi kalpler
😘|kiss|öpücük
😎|cool sunglasses|havalı gözlük
🤔|think|düşün
🤨|skeptical|şüpheli
😐|neutral|ifadesiz
🙄|eye roll|göz devir
😏|smirk|sırıt
😴|sleep|uyku
😭|cry sad|ağla üzgün
😢|sad tear|üzgün gözyaşı
😡|angry|kızgın
😱|shock scream|şaşkın çığlık
🤯|mind blown|şaşkın
🥳|party celebrate|parti kutla
🤩|star excited|heyecan yıldız
🥺|please pleading|lütfen yalvar
🤗|hug|sarıl
🤭|giggle|kıkırda
🫡|salute|selam
🙂|slight smile|hafif gülümse
🙃|upside down|ters yüz
😅|sweat smile nervous|terli gülüş gergin
🤪|zany crazy|çılgın
😜|wink tongue|dil çıkar göz kırp
😝|squint tongue|dil çıkar
😛|tongue|dil
🤑|money|para
😋|yum tasty|lezzetli
😇|angel innocent|melek masum
☺️|relaxed smile|rahat gülümse
😚|kiss closed eyes|öpücük
😙|kiss smile|öpücük gülümse
😗|kiss|öpücük
🤤|drool|salya
😌|relieved|rahatlamış
😔|pensive|düşünceli
😪|sleepy|uykulu
🥱|yawn bored|esne sıkıldım
😷|mask sick|maske hasta
🤒|fever sick|ateş hasta
🤕|hurt bandage|yaralı
🤢|nauseated|mide bulantısı
🤮|vomit|kus
🤧|sneeze|hapşır
🥵|hot|sıcak
🥶|cold freezing|soğuk donmuş
🥴|woozy dizzy|sersem
😵|dizzy|baş dönmesi
🤠|cowboy|kovboy
🤓|nerd|inek
🧐|monocle curious|meraklı
😕|confused|kafası karışık
😟|worried|endişeli
🙁|slight frown|hafif somurt
☹️|frown|somurt
😮|open mouth wow|ağzı açık vay
😯|hushed|şaşırmış
😲|astonished|hayret
😳|flushed embarrassed|utanmış kızarık
😦|frowning|somurtkan
😧|anguished|kederli
😨|fearful scared|korkmuş
😰|anxious sweat|kaygılı
😥|sad relieved|üzgün rahat
😓|downcast sweat|terli üzgün
😖|confounded|perişan
😣|persevere|sebat
😞|disappointed|hayal kırıklığı
😩|weary|bitkin
😫|tired|yorgun
😤|triumph steam|zafer burun
😠|mad angry|öfkeli
🤬|swear cursing|küfür
😈|devil smile|şeytan gülüş
👿|imp devil|şeytan kızgın
💀|skull dead|kafatası ölü
☠️|skull crossbones|korsan kafatası
💩|poop|kaka
🤡|clown|palyaço
👹|ogre|dev
👺|goblin|gulyabani
👻|ghost|hayalet
👽|alien|uzaylı
👾|space invader game|uzay istilacısı oyun
🤖|robot|robot
😺|cat smile|kedi gülüş
😸|cat grin|kedi sırıt
😹|cat joy tears|kedi kahkaha
😻|cat love|kedi aşk
😼|cat smirk|kedi sırıtma
😽|cat kiss|kedi öpücük
🙀|cat weary|kedi şaşkın
😿|cat cry|kedi ağla
😾|cat pout|kedi küs
🙈|see no evil monkey|görmedim maymun
🙉|hear no evil monkey|duymadım maymun
🙊|speak no evil monkey|söylemedim maymun
🤫|shush quiet|sus sessiz
🤥|lie liar|yalan
😶|no mouth silent|ağızsız sessiz
😑|expressionless|ifadesiz
😬|grimace awkward|yüz buruştur garip
🤐|zipper mouth|ağzı fermuarlı
`,
  gestures: `
👍|thumb up like yes|beğen evet onay
👎|thumb down dislike|beğenme hayır
👏|clap|alkış
🙌|hooray|yaşasın
🙏|thanks please|teşekkür lütfen
👋|wave hello|selam merhaba
🤝|handshake|tokalaş
💪|strong muscle|güç kas
👌|okay|tamam
✌️|peace victory|barış zafer
🤞|luck|şans
🤘|rock|rock
✋|raised hand stop|el kaldır dur
🤚|back of hand|el arkası
🖐️|hand fingers|el parmaklar
🖖|vulcan salute|vulkan selamı
🤙|call me|ara beni
👈|point left|sola işaret
👉|point right|sağa işaret
👆|point up|yukarı işaret
👇|point down|aşağı işaret
☝️|index up|işaret parmağı
🤟|love you|seni seviyorum
✊|raised fist|yumruk
👊|fist bump punch|yumruk tokuş
🤛|left fist|sol yumruk
🤜|right fist|sağ yumruk
👐|open hands|açık eller
🤲|palms up|avuç
🤏|pinch small|çimdik küçük
✍️|write|yaz
💅|nail polish|oje
🤳|selfie|özçekim
🦾|mechanical arm|mekanik kol
🦵|leg|bacak
🦶|foot|ayak
👂|ear|kulak
👃|nose|burun
🧠|brain|beyin
🦷|tooth|diş
🦴|bone|kemik
👁️|eye|göz
👅|tongue|dil
👄|mouth lips|ağız dudak
💋|kiss mark|öpücük izi
👶|baby|bebek
🧒|child|çocuk
🧑|person|kişi
🧓|older person|yaşlı
👮|police|polis
🕵️|detective|dedektif
💂|guard|muhafız
👷|construction worker|inşaat işçisi
🤴|prince|prens
👸|princess|prenses
🧙|mage wizard|büyücü
🧚|fairy|peri
🧛|vampire|vampir
🧜|merperson|denizkızı
🧝|elf|elf
🧞|genie|cin
🧟|zombie|zombi
🦸|superhero|süper kahraman
🦹|supervillain|kötü karakter
🙋|raising hand|el kaldıran
🙇|bow|eğil
🤦|facepalm|yüzünü kapat
🤷|shrug|omuz silk
🙆|ok gesture|tamam hareketi
🙅|no gesture|hayır hareketi
💁|tipping hand info|bilgi
🏃|run|koş
🚶|walk|yürü
💃|dance|dans
🕺|dance man|dans adam
👯|bunny dancers|tavşan dansçılar
🧘|yoga meditate|yoga meditasyon
🛌|sleep bed|yatak uyku
👪|family|aile
👫|couple|çift
🗣️|speaking head|konuşan baş
👤|silhouette|siluet
👥|people|insanlar
`,
  nature: `
🔥|fire hot|ateş sıcak
✨|sparkles|parıltı
⭐|star|yıldız
🌈|rainbow|gökkuşağı
☀️|sun|güneş
🌙|moon|ay
🐱|cat|kedi
🐶|dog|köpek
🌸|flower|çiçek
🐭|mouse|fare
🐹|hamster|hamster
🐰|rabbit bunny|tavşan
🦊|fox|tilki
🐻|bear|ayı
🐼|panda|panda
🐨|koala|koala
🐯|tiger|kaplan
🦁|lion|aslan
🐮|cow|inek
🐷|pig|domuz
🐸|frog|kurbağa
🐵|monkey|maymun
🐔|chicken|tavuk
🐧|penguin|penguen
🐦|bird|kuş
🐤|chick|civciv
🦆|duck|ördek
🦅|eagle|kartal
🦉|owl|baykuş
🦇|bat|yarasa
🐺|wolf|kurt
🐗|boar|yaban domuzu
🐴|horse|at
🦄|unicorn|tek boynuzlu at
🐝|bee|arı
🐛|bug caterpillar|tırtıl böcek
🦋|butterfly|kelebek
🐌|snail|salyangoz
🐞|ladybug|uğur böceği
🐜|ant|karınca
🕷️|spider|örümcek
🕸️|spider web|örümcek ağı
🦂|scorpion|akrep
🐢|turtle|kaplumbağa
🐍|snake|yılan
🦎|lizard|kertenkele
🦖|t-rex dinosaur|dinozor
🦕|sauropod dinosaur|uzun boyunlu dinozor
🐙|octopus|ahtapot
🦑|squid|kalamar
🦐|shrimp|karides
🦀|crab|yengeç
🐡|blowfish|balon balığı
🐠|tropical fish|tropik balık
🐟|fish|balık
🐬|dolphin|yunus
🐳|whale|balina
🦈|shark|köpekbalığı
🐊|crocodile|timsah
🐅|tiger walking|kaplan yürüyen
🐆|leopard|leopar
🦓|zebra|zebra
🦍|gorilla|goril
🐘|elephant|fil
🦛|hippo|su aygırı
🦏|rhino|gergedan
🐪|camel|deve
🦒|giraffe|zürafa
🦘|kangaroo|kanguru
🐄|cow standing|inek ayakta
🐎|racing horse|yarış atı
🐖|pig standing|domuz ayakta
🐑|sheep|koyun
🐐|goat|keçi
🦌|deer|geyik
🐕|dog walking|köpek yürüyen
🐩|poodle|kaniş
🐈|cat walking|kedi yürüyen
🐓|rooster|horoz
🦃|turkey|hindi
🦚|peacock|tavuskuşu
🦜|parrot|papağan
🦢|swan|kuğu
🦩|flamingo|flamingo
🕊️|dove peace|güvercin barış
🐇|rabbit running|koşan tavşan
🦝|raccoon|rakun
🦨|skunk|kokarca
🦦|otter|su samuru
🦥|sloth|tembel hayvan
🐁|mouse running|koşan fare
🐀|rat|sıçan
🐿️|chipmunk squirrel|sincap
🦔|hedgehog|kirpi
🐾|paw prints|pati izi
🐉|dragon|ejderha
🌵|cactus|kaktüs
🎄|christmas tree|yılbaşı ağacı
🌲|evergreen tree|çam ağacı
🌳|tree|ağaç
🌴|palm tree|palmiye
🌱|seedling sprout|fide filiz
🌿|herb|ot bitki
☘️|shamrock|yonca
🍀|four leaf clover luck|dört yapraklı yonca şans
🍁|maple leaf|akçaağaç yaprağı
🍂|fallen leaves autumn|dökülen yapraklar sonbahar
🍃|leaves wind|yapraklar rüzgar
🍄|mushroom|mantar
🌾|rice sheaf|başak
💐|bouquet|buket
🌷|tulip|lale
🌹|rose|gül
🥀|wilted flower|solmuş çiçek
🌺|hibiscus|ebegümeci
🌻|sunflower|ayçiçeği
🌼|blossom|çiçek açmış
🌞|sun face|güneş yüzü
🌝|full moon face|dolunay yüzü
🌚|new moon face|yeni ay yüzü
🌕|full moon|dolunay
🌑|new moon|yeni ay
🌍|earth europe africa|dünya avrupa afrika
🌎|earth americas|dünya amerika
🌏|earth asia|dünya asya
🪐|planet saturn|gezegen satürn
💫|dizzy star|baş dönmesi yıldız
🌟|glowing star|parlayan yıldız
⚡|lightning zap|şimşek
☄️|comet|kuyruklu yıldız
💥|boom collision|patlama
🌤️|sun small cloud|az bulutlu
⛅|sun behind cloud|parçalı bulutlu
🌥️|cloudy|bulutlu
☁️|cloud|bulut
🌦️|sun rain|güneşli yağmur
🌧️|rain|yağmur
⛈️|storm thunder|fırtına gök gürültüsü
🌩️|lightning cloud|şimşekli bulut
🌨️|snow cloud|karlı bulut
❄️|snowflake|kar tanesi
☃️|snowman snow|kardan adam kar
⛄|snowman|kardan adam
🌬️|wind face|rüzgar yüzü
💨|dash wind|rüzgar hız
🌪️|tornado|hortum
🌫️|fog|sis
🌊|wave ocean|dalga okyanus
💧|droplet|damla
💦|sweat splash|ter sıçrama
☔|umbrella rain|şemsiye yağmur
`,
  food: `
☕|coffee|kahve
🍕|pizza|pizza
🍔|burger|hamburger
🍿|popcorn|patlamış mısır
🎂|cake birthday|pasta doğum günü
🍻|cheers beer|şerefe bira
🍏|green apple|yeşil elma
🍎|red apple|kırmızı elma
🍐|pear|armut
🍊|orange tangerine|portakal mandalina
🍋|lemon|limon
🍌|banana|muz
🍉|watermelon|karpuz
🍇|grapes|üzüm
🍓|strawberry|çilek
🍈|melon|kavun
🍒|cherries|kiraz
🍑|peach|şeftali
🥭|mango|mango
🍍|pineapple|ananas
🥥|coconut|hindistan cevizi
🥝|kiwi|kivi
🍅|tomato|domates
🍆|eggplant|patlıcan
🥑|avocado|avokado
🥦|broccoli|brokoli
🥬|leafy green lettuce|yeşillik marul
🥒|cucumber|salatalık
🌶️|hot pepper|acı biber
🌽|corn|mısır
🥕|carrot|havuç
🧄|garlic|sarımsak
🧅|onion|soğan
🥔|potato|patates
🍠|sweet potato|tatlı patates
🥐|croissant|kruvasan
🥯|bagel|simit
🍞|bread|ekmek
🥖|baguette|baget
🥨|pretzel|pretzel
🧀|cheese|peynir
🥚|egg|yumurta
🍳|cooking fried egg|yemek sahanda yumurta
🧈|butter|tereyağı
🥞|pancakes|pankek
🧇|waffle|waffle
🥓|bacon|pastırma
🥩|steak meat|biftek et
🍗|chicken leg|tavuk but
🍖|meat bone|kemikli et
🌭|hot dog|sosisli
🥪|sandwich|sandviç
🌮|taco|tako
🌯|burrito wrap|dürüm
🥙|pita kebab|pide döner
🧆|falafel|falafel
🥗|salad|salata
🥘|paella pan|tava yemeği
🍝|spaghetti pasta|spagetti makarna
🍜|ramen noodles|ramen erişte
🍲|stew pot|güveç
🍛|curry rice|köri pilav
🍣|sushi|suşi
🍱|bento|bento
🥟|dumpling|mantı
🍤|fried shrimp|kızarmış karides
🍙|rice ball|pirinç topu
🍚|rice|pilav
🍘|rice cracker|pirinç krakeri
🍥|fish cake|balık keki
🥠|fortune cookie|şans kurabiyesi
🍢|oden skewer|şiş
🍡|dango|dango
🍧|shaved ice|kar buzu
🍨|ice cream|dondurma
🍦|soft ice cream|külah dondurma
🥧|pie|turta
🧁|cupcake|kek
🍰|cake slice|pasta dilimi
🍮|custard pudding|puding
🍭|lollipop|lolipop
🍬|candy|şeker
🍫|chocolate|çikolata
🍩|doughnut donut|donut
🍪|cookie|kurabiye
🌰|chestnut|kestane
🥜|peanuts|fıstık
🍯|honey|bal
🥛|milk|süt
🍼|baby bottle|biberon
🍵|tea|çay
🧃|juice box|meyve suyu
🥤|cup straw soda|pipetli bardak gazoz
🍶|sake|sake
🍺|beer|bira
🥂|clinking glasses toast|kadeh tokuşturma
🍷|wine|şarap
🥃|whisky tumbler|viski
🍸|cocktail|kokteyl
🍹|tropical drink|tropik içecek
🍾|champagne bottle|şampanya
🧊|ice cube|buz
🥄|spoon|kaşık
🍴|fork knife|çatal bıçak
🍽️|plate dinner|tabak akşam yemeği
🥣|bowl spoon cereal|kase kaşık
🥡|takeout box|paket yemek
🥢|chopsticks|yemek çubukları
🧂|salt|tuz
🍟|fries|patates kızartması
🥫|canned food|konserve
`,
  activities: `
🎉|party celebration|parti kutlama
🎊|confetti|konfeti
🎮|game controller|oyun kontrol
🏆|trophy winner|kupa kazanan
⚽|football|futbol
🎵|music note|müzik nota
🎸|guitar|gitar
🎃|jack o lantern halloween|cadılar bayramı balkabağı
🎆|fireworks|havai fişek
🎇|sparkler|maytap
🧨|firecracker|kestane fişeği
🎈|balloon|balon
🎀|ribbon|kurdele
🎗️|reminder ribbon|anma kurdelesi
🎟️|admission tickets|giriş biletleri
🎫|ticket|bilet
🎖️|military medal|askeri madalya
🏅|medal|madalya
🥇|gold first|altın birinci
🥈|silver second|gümüş ikinci
🥉|bronze third|bronz üçüncü
🏀|basketball|basketbol
🏈|american football|amerikan futbolu
⚾|baseball|beyzbol
🥎|softball|softbol
🎾|tennis|tenis
🏐|volleyball|voleybol
🏉|rugby|ragbi
🥏|frisbee flying disc|frizbi
🎱|pool 8 ball billiards|bilardo
🏓|ping pong|masa tenisi
🏸|badminton|badminton
🏒|ice hockey|buz hokeyi
🏑|field hockey|çim hokeyi
🥍|lacrosse|lakros
🏏|cricket|kriket
🥅|goal net|kale ağı
⛳|golf|golf
🏹|bow arrow|yay ok
🎣|fishing|balık tutma
🤿|diving mask|dalış maskesi
🥊|boxing glove|boks eldiveni
🥋|martial arts|dövüş sanatları
🎽|running shirt|koşu atleti
🛹|skateboard|kaykay
🛷|sled|kızak
⛸️|ice skate|buz pateni
🥌|curling stone|curling taşı
🎿|ski|kayak
⛷️|skier|kayakçı
🏂|snowboard|snowboard
🪂|parachute|paraşüt
🏋️|weight lifting gym|halter spor salonu
🤸|cartwheel|yan perende
⛹️|bouncing ball|top sektiren
🤺|fencing|eskrim
🤾|handball|hentbol
🏌️|golfer|golfçü
🏇|horse racing|at yarışı
🧗|climbing|tırmanış
🚴|cycling bike|bisiklet sürmek
🏊|swimming|yüzme
🏄|surfing|sörf
🚣|rowing|kürek
🤽|water polo|sutopu
🎯|bullseye target dart|hedef dart
🪀|yo-yo|yoyo
🪁|kite|uçurtma
🔮|crystal ball|kristal küre
🧿|nazar amulet|nazar boncuğu
🎲|dice game|zar oyun
🧩|puzzle|yapboz
🧸|teddy bear|oyuncak ayı
♟️|chess pawn|satranç piyon
🃏|joker card|joker kart
🀄|mahjong|mahjong
🎴|flower cards|çiçek kartları
🎭|theater masks|tiyatro maskeleri
🎨|art palette|sanat palet
🎬|clapper film|klaket film
🎤|microphone sing karaoke|mikrofon şarkı karaoke
🎧|headphones|kulaklık
🎼|musical score|nota defteri
🎶|music notes|müzik notaları
🎹|piano keyboard|piyano
🥁|drum|davul
🎷|saxophone|saksafon
🎺|trumpet|trompet
🎻|violin|keman
🪕|banjo|banjo
🕹️|joystick|oyun kolu
🎳|bowling|bovling
🎰|slot machine|kumar makinesi
`,
  travel: `
🚗|car|araba
🚕|taxi|taksi
🚙|suv|arazi aracı
🚌|bus|otobüs
🚎|trolleybus|troleybüs
🏎️|race car|yarış arabası
🚓|police car|polis arabası
🚑|ambulance|ambulans
🚒|fire engine|itfaiye
🚐|minibus|minibüs
🚚|delivery truck|teslimat kamyonu
🚛|lorry|tır
🚜|tractor|traktör
🛴|kick scooter|scooter
🚲|bicycle|bisiklet
🛵|motor scooter|motorlu scooter
🏍️|motorcycle|motosiklet
🛺|auto rickshaw|çekçek
🚨|siren|siren
🚔|oncoming police car|gelen polis arabası
🚍|oncoming bus|gelen otobüs
🚘|oncoming car|gelen araba
🚖|oncoming taxi|gelen taksi
🚡|aerial tramway|hava tramvayı
🚠|cable car|teleferik
🚟|suspension railway|asma demiryolu
🚃|railway car|vagon
🚋|tram car|tramvay vagonu
🚞|mountain railway|dağ treni
🚝|monorail|monoray
🚄|high speed train|yüksek hızlı tren
🚅|bullet train|hızlı tren
🚈|light rail|hafif raylı
🚂|locomotive|lokomotif
🚆|train|tren
🚇|metro subway|metro
🚊|tram|tramvay
🚉|station|istasyon
✈️|airplane|uçak
🛫|departure|kalkış
🛬|arrival|varış
🛩️|small airplane|küçük uçak
💺|seat|koltuk
🛰️|satellite|uydu
🚁|helicopter|helikopter
🛸|ufo|ufo
⛵|sailboat|yelkenli
🚤|speedboat|sürat teknesi
🛥️|motor boat|motorbot
🛳️|passenger ship|yolcu gemisi
⛴️|ferry|feribot
🚢|ship|gemi
⚓|anchor|çapa
⛽|fuel pump|benzin
🚧|construction|inşaat
🚦|traffic light|trafik ışığı
🚥|horizontal traffic light|yatay trafik ışığı
🗺️|world map|dünya haritası
🧭|compass|pusula
🗿|moai|moai
🗽|statue of liberty|özgürlük heykeli
🗼|tokyo tower|tokyo kulesi
🏰|castle|kale
🏯|japanese castle|japon kalesi
🏟️|stadium|stadyum
🎡|ferris wheel|dönme dolap
🎢|roller coaster|hız treni
🎠|carousel|atlıkarınca
⛲|fountain|çeşme
⛱️|beach umbrella|plaj şemsiyesi
🏖️|beach|plaj
🏝️|island|ada
🏜️|desert|çöl
🌋|volcano|yanardağ
⛰️|mountain|dağ
🏔️|snow mountain|karlı dağ
🗻|mount fuji|fuji dağı
🏕️|camping|kamp
⛺|tent|çadır
🏠|house home|ev
🏡|house garden|bahçeli ev
🏘️|houses|evler
🏚️|derelict house|harabe ev
🏗️|building construction|inşaat binası
🏭|factory|fabrika
🏢|office building|ofis binası
🏬|department store|alışveriş merkezi
🏣|post office|postane
🏥|hospital|hastane
🏦|bank|banka
🏨|hotel|otel
🏪|convenience store|market
🏫|school|okul
💒|wedding|düğün
🏛️|classical building|tarihi bina
⛪|church|kilise
🕌|mosque|cami
🕍|synagogue|sinagog
🛕|hindu temple|hindu tapınağı
⛩️|shinto shrine|şinto tapınağı
🕋|kaaba|kabe
🌁|foggy city|sisli şehir
🌃|night stars|yıldızlı gece
🏙️|cityscape|şehir
🌄|sunrise mountains|dağda gün doğumu
🌅|sunrise|gün doğumu
🌆|city dusk|şehirde akşam
🌇|sunset|gün batımı
🌉|bridge night|gece köprü
🎑|moon viewing|ay seyri
🏞️|national park|milli park
🌌|milky way|samanyolu
🌠|shooting star|kayan yıldız
`,
  objects: `
🚀|rocket|roket
💡|idea light|fikir ışık
💻|computer|bilgisayar
📌|pin|sabitle
🎁|gift|hediye
👀|eyes look|göz bak
💤|sleep|uyku
⌚|watch|kol saati
📱|phone mobile|telefon cep
📲|phone arrow call|telefon ok arama
⌨️|keyboard|klavye
🖥️|desktop computer|masaüstü bilgisayar
🖨️|printer|yazıcı
🖱️|computer mouse|bilgisayar faresi
💽|minidisc|minidisk
💾|floppy disk save|disket kaydet
💿|cd|cd
📀|dvd|dvd
📷|camera|kamera
📸|camera flash|flaşlı kamera
📹|video camera|video kamera
🎥|movie camera|film kamerası
📽️|projector|projektör
📞|telephone receiver|telefon ahizesi
☎️|telephone|telefon
📺|tv television|televizyon
📻|radio|radyo
🎙️|studio microphone podcast|stüdyo mikrofonu podcast
⏰|alarm clock|çalar saat
⏳|hourglass|kum saati
⌛|hourglass done|kum saati bitti
⏱️|stopwatch|kronometre
⏲️|timer|zamanlayıcı
🕰️|mantel clock|masa saati
📡|satellite antenna|uydu anteni
🔋|battery|pil
🔌|plug|fiş
🔦|flashlight|el feneri
🕯️|candle|mum
🧯|fire extinguisher|yangın söndürücü
💸|money wings|uçan para
💵|dollar|dolar
💶|euro|avro
💰|money bag|para çantası
💳|credit card|kredi kartı
💎|gem diamond|mücevher elmas
⚖️|scales balance|terazi
🧰|toolbox|alet çantası
🔧|wrench|ingiliz anahtarı
🔨|hammer|çekiç
⚒️|hammer pick|çekiç kazma
🛠️|tools|aletler
⛏️|pick|kazma
🔩|nut bolt|somun cıvata
⚙️|gear settings|dişli ayarlar
🧱|brick|tuğla
⛓️|chains|zincir
🧲|magnet|mıknatıs
🔫|water pistol|su tabancası
💣|bomb|bomba
🔪|knife|bıçak
🗡️|dagger|hançer
⚔️|swords|kılıçlar
🛡️|shield|kalkan
🏺|amphora|amfora
💈|barber|berber
🔭|telescope|teleskop
🔬|microscope|mikroskop
🩹|bandage|yara bandı
🩺|stethoscope|steteskop
💊|pill|hap
💉|syringe|şırınga
🧬|dna|dna
🦠|microbe virus|mikrop virüs
🧪|test tube|deney tüpü
🌡️|thermometer|termometre
🧹|broom|süpürge
🧺|basket|sepet
🧻|toilet paper|tuvalet kağıdı
🚽|toilet|tuvalet
🚿|shower|duş
🛁|bathtub|küvet
🧼|soap|sabun
🧽|sponge|sünger
🔑|key|anahtar
🗝️|old key|eski anahtar
🚪|door|kapı
🪑|chair|sandalye
🛋️|couch|kanepe
🛏️|bed|yatak
🧳|luggage|bavul
🛍️|shopping bags|alışveriş poşetleri
🛒|shopping cart|alışveriş arabası
🧧|red envelope|kırmızı zarf
✉️|envelope mail|zarf posta
📩|envelope arrow|gelen posta
📨|incoming envelope|gelen zarf
📧|email|e-posta
📦|package box|paket kutu
📮|postbox|posta kutusu
🏷️|label tag|etiket
📜|scroll|parşömen
📃|page curl|kıvrık sayfa
📄|document page|belge sayfa
📑|bookmark tabs|sekmeler
📊|bar chart|çubuk grafik
📈|chart up|yükselen grafik
📉|chart down|düşen grafik
🗒️|notepad|not defteri
🗓️|spiral calendar|spiral takvim
📆|tear off calendar|takvim
📅|date|tarih
🗑️|wastebasket trash|çöp kutusu
📇|card index|kart dizini
🗃️|card file box|dosya kutusu
🗳️|ballot box|oy sandığı
🗄️|file cabinet|dosya dolabı
📋|clipboard|pano
📁|folder|klasör
📂|open folder|açık klasör
🗂️|dividers|ayırıcılar
🗞️|rolled newspaper|rulo gazete
📰|newspaper|gazete
📓|notebook|defter
📔|decorated notebook|süslü defter
📒|ledger|hesap defteri
📕|closed book|kapalı kitap
📗|green book|yeşil kitap
📘|blue book|mavi kitap
📙|orange book|turuncu kitap
📚|books|kitaplar
📖|open book read|açık kitap oku
🔖|bookmark|yer imi
🔗|link|bağlantı
📎|paperclip|ataç
🖇️|linked paperclips|bağlı ataçlar
📐|triangle ruler|gönye
📏|ruler|cetvel
✂️|scissors|makas
🖊️|pen|tükenmez kalem
🖋️|fountain pen|dolma kalem
✒️|nib|uç
🖌️|paintbrush|fırça
🖍️|crayon|pastel boya
📝|memo note|not
✏️|pencil|kurşun kalem
🔍|search magnifier|ara büyüteç
🔎|magnifier right|sağa büyüteç
🔏|lock pen|kilit kalem
🔐|lock key|kilit anahtar
🔒|locked|kilitli
🔓|unlocked|kilidi açık
🔔|bell|zil
🔕|bell muted|sessiz zil
📣|megaphone|megafon
📢|loudspeaker|hoparlör
💬|speech bubble|konuşma balonu
💭|thought bubble|düşünce balonu
🗯️|anger bubble|öfke balonu
🎓|graduation cap|mezuniyet kepi
👑|crown|taç
🎩|top hat|silindir şapka
🧢|cap|şapka
👓|glasses|gözlük
🕶️|sunglasses|güneş gözlüğü
🥽|goggles|koruyucu gözlük
👔|necktie|kravat
👕|t-shirt|tişört
👖|jeans|kot
🧣|scarf|atkı
🧤|gloves|eldiven
🧥|coat|mont
🧦|socks|çorap
👗|dress|elbise
👘|kimono|kimono
👙|bikini|bikini
👛|purse|cüzdan
👜|handbag|el çantası
🎒|backpack|sırt çantası
👞|shoe|ayakkabı
👟|sneaker|spor ayakkabı
👠|high heel|topuklu
👢|boot|çizme
💄|lipstick|ruj
💍|ring|yüzük
🧮|abacus|abaküs
🎐|wind chime|rüzgar çanı
🪒|razor|tıraş bıçağı
🧷|safety pin|çengelli iğne
🧵|thread|iplik
🧶|yarn|yün
`,
  symbols: `
❤️|red heart love|kırmızı kalp sevgi
🧡|orange heart|turuncu kalp
💛|yellow heart|sarı kalp
💚|green heart|yeşil kalp
💙|blue heart|mavi kalp
💜|purple heart|mor kalp
🖤|black heart|siyah kalp
🤍|white heart|beyaz kalp
💔|broken heart|kırık kalp
💯|hundred perfect|yüz mükemmel
✅|check done|onay tamam
❌|cross no|çarpı hayır
❓|question|soru
🤎|brown heart|kahverengi kalp
💕|two hearts|iki kalp
💞|revolving hearts|dönen kalpler
💓|beating heart|atan kalp
💗|growing heart|büyüyen kalp
💖|sparkling heart|parlayan kalp
💘|heart arrow|oklu kalp
💝|heart ribbon|kurdeleli kalp
💟|heart decoration|kalp süsü
❣️|heart exclamation|kalp ünlem
💌|love letter|aşk mektubu
💢|anger symbol|öfke simgesi
💮|white flower|beyaz çiçek
♻️|recycle|geri dönüşüm
⚠️|warning|uyarı
🚫|prohibited|yasak
⛔|no entry|giriş yok
🛑|stop sign|dur işareti
📛|name badge|isim rozeti
🔞|no under eighteen|on sekiz yaş altı
📵|no phones|telefon yok
🔇|muted speaker|sessiz hoparlör
🔈|speaker low|düşük ses
🔉|speaker medium|orta ses
🔊|speaker loud|yüksek ses
❗|exclamation|ünlem
❕|white exclamation|beyaz ünlem
❔|white question|beyaz soru
‼️|double exclamation|çift ünlem
⁉️|exclamation question|ünlem soru
✔️|check mark|onay işareti
☑️|ballot check|onay kutusu
✖️|multiply|çarpı işareti
➕|plus|artı
➖|minus|eksi
➗|divide|bölü
♾️|infinity|sonsuz
💲|dollar sign|dolar işareti
💱|currency exchange|döviz
™️|trademark|ticari marka
©️|copyright|telif
®️|registered|tescilli
〰️|wavy dash|dalgalı çizgi
➰|curly loop|kıvrım
🔃|clockwise arrows|saat yönü oklar
🔄|counterclockwise arrows refresh|yenile oklar
🔙|back arrow|geri
🔚|end arrow|son
🔛|on arrow|açık
🔜|soon arrow|yakında
🔝|top arrow|en üst
⬆️|up arrow|yukarı ok
⬇️|down arrow|aşağı ok
⬅️|left arrow|sol ok
➡️|right arrow|sağ ok
↗️|up right arrow|sağ üst ok
↘️|down right arrow|sağ alt ok
↙️|down left arrow|sol alt ok
↖️|up left arrow|sol üst ok
↕️|up down arrow|yukarı aşağı ok
↔️|left right arrow|sol sağ ok
↩️|return left|sola dön
↪️|return right|sağa dön
⤴️|curve up|yukarı kıvrım
⤵️|curve down|aşağı kıvrım
🔀|shuffle|karıştır
🔁|repeat|tekrarla
🔂|repeat one|bir kez tekrarla
▶️|play|oynat
⏸️|pause|duraklat
⏹️|stop|durdur
⏺️|record|kaydet
⏭️|next track|sonraki parça
⏮️|previous track|önceki parça
⏩|fast forward|ileri sar
⏪|rewind|geri sar
🔅|dim|loş
🔆|bright|parlak
📶|signal bars|sinyal
📳|vibration|titreşim
📴|phone off|telefon kapalı
♀️|female|kadın
♂️|male|erkek
⚕️|medical|tıp
🔱|trident|yaba
⚜️|fleur de lis|zambak
🔰|beginner|acemi
⭕|circle|halka
❎|cross button|çarpı düğmesi
✳️|asterisk|yıldız işareti
✴️|eight point star|sekiz köşeli yıldız
❇️|sparkle|ışıltı
🆗|ok button|tamam düğmesi
🆒|cool button|havalı düğmesi
🆕|new button|yeni düğmesi
🆓|free button|ücretsiz düğmesi
🆙|up button|yukarı düğmesi
🆘|sos help|imdat yardım
🆚|vs versus|karşı
ℹ️|information|bilgi
🔴|red circle|kırmızı daire
🟠|orange circle|turuncu daire
🟡|yellow circle|sarı daire
🟢|green circle|yeşil daire
🔵|blue circle|mavi daire
🟣|purple circle|mor daire
🟤|brown circle|kahverengi daire
⚫|black circle|siyah daire
⚪|white circle|beyaz daire
🟥|red square|kırmızı kare
🟧|orange square|turuncu kare
🟨|yellow square|sarı kare
🟩|green square|yeşil kare
🟦|blue square|mavi kare
🟪|purple square|mor kare
🟫|brown square|kahverengi kare
⬛|black square|siyah kare
⬜|white square|beyaz kare
🔶|orange diamond|turuncu elmas
🔷|blue diamond|mavi elmas
🔺|red triangle up|kırmızı üçgen yukarı
🔻|red triangle down|kırmızı üçgen aşağı
💠|diamond dot|noktalı elmas
🔘|radio button|seçim düğmesi
🏁|chequered flag finish|damalı bayrak bitiş
🚩|red flag|kırmızı bayrak
🏳️|white flag|beyaz bayrak
🏴|black flag|siyah bayrak
☮️|peace|barış
☯️|yin yang|yin yang
🎦|cinema|sinema
🔤|abc letters|harfler
🔢|numbers|sayılar
`
};

export const chatEmojiCatalog: readonly ChatEmojiEntry[] = chatEmojiGroups.flatMap((group) =>
  chatEmojiSource[group]
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): ChatEmojiEntry => {
      const [emoji = "", en = "", tr = ""] = line.split("|");
      return [emoji, group, en, tr];
    })
);

export const maxMessageReactionKinds = 8;
export const chatEmojiSet: ReadonlySet<string> = new Set(chatEmojiCatalog.map(([emoji]) => emoji));

export type MentionTarget = { kind: "person"; userId: string } | { kind: "everyone" | "here" };
export type MessageMentionInput = MentionTarget & { id?: string; start: number; end: number };
export type MessageMention = MessageMentionInput & {
  /** Stable occurrence identity: a new collective label gets a new snapshot. */
  id: string;
  nickname: string;
  mentionCode: string;
  authorDeleted: boolean;
  /** Frozen on creation; used only for presentation, never authorization. */
  recipientIds: string[];
};
export interface MessageReaction {
  emoji: string;
  userIds: string[];
}
export interface MessageReactionState {
  version: number;
  reactions: MessageReaction[];
}
export interface MessageReactionsEvent extends MessageReactionState {
  serverId: string;
  roomId: string;
  messageId: string;
}

/** Ranges refer to the exact plain body, in JavaScript's UTF-16 units. */
export function validMentionRanges(body: string, mentions: MessageMentionInput[]) {
  let previousEnd = 0;
  for (const mention of mentions) {
    if (
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < previousEnd ||
      mention.end <= mention.start ||
      mention.end > body.length ||
      body[mention.start] !== "@"
    )
      return false;
    const text = body.slice(mention.start, mention.end);
    if (mention.kind !== "person" && text !== `@${mention.kind}`) return false;
    previousEnd = mention.end;
  }
  return true;
}

/** Rebase generated labels without changing the surrounding authored text. */
export function rewriteMentionLabels(body: string, mentions: MessageMention[]) {
  let result = "",
    offset = 0;
  const rewritten: MessageMention[] = [];
  for (const mention of mentions) {
    result += body.slice(offset, mention.start);
    const label =
      mention.kind !== "person"
        ? `@${mention.kind}`
        : mention.authorDeleted
          ? `@#${mention.mentionCode}`
          : `@${mention.nickname}`;
    const start = result.length;
    result += label;
    rewritten.push({ ...mention, start, end: result.length });
    offset = mention.end;
  }
  return { body: result + body.slice(offset), mentions: rewritten };
}
