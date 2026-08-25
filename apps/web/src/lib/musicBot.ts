/**
 * The Music bot as the browser sees it.
 *
 * The client never decides what the bot may do — the server authorizes a
 * request and the bot carries it out. What lives here is only what the browser
 * needs to draw the control: whether a bot is in the room, whether it is
 * playing, and what to say when the server refuses.
 */

import type {
  MusicCommand,
  MusicControlAck,
  MusicControlError,
  MusicQueueState,
  MusicSearchResult,
  MusicSetLogAction,
  MusicTrackSummary,
  VoiceMemberState
} from "@voxly/shared";
import type { TranslationKey } from "./i18n.js";

export type { MusicCommand };

interface MusicSocket {
  emit: (
    event: "music:control",
    payload: { roomId: string; command: MusicCommand },
    ack: (response: MusicControlAck) => void
  ) => void;
}

/**
 * A server has at most one Music bot, so the first bot in the room is it.
 * Presence marks service accounts; nothing here inspects a nickname, which an
 * owner is free to change.
 */
export function musicBotIn(members: VoiceMemberState[]): VoiceMemberState | undefined {
  return members.find((member) => member.user.isBot === true);
}

/**
 * What the transport controls are looking at.
 *
 * Everything here is read from the Queue the bot published, and deliberately
 * not from the bot's `speaking` flag on the voice snapshot. Both are answers to
 * "is the music playing" and they can disagree — the server clamps `speaking`
 * off for a muted member, and the two arrive in separate messages — so the
 * panel picks one and it is the one the Queue's own rows already read. Play,
 * Pause, Skip and the Queue then change together, out of one message, and a
 * refusal leaves every client showing exactly what the bot shows. ADR-0006
 * records the choice.
 *
 * A mute stays visible, but as a sentence rather than as a button state: media
 * is peer-to-peer, so an owner's mute does not by itself stop the bot's
 * packets, and a member is owed that. It no longer decides what the button
 * offers, because the Queue can now say whether there is anything to pause.
 */
export interface MusicTransport {
  /** A Music bot is in this room, so there is something to control at all. */
  present: boolean;
  /** Whether the head of the Queue is sounding right now. */
  playing: boolean;
  /**
   * The entry Play, Pause and Skip act on — the head of the Queue — or `null`
   * when there is nothing queued and those controls have nothing to name.
   */
  currentEntryId: string | null;
  /** An owner muted the bot. Information for the member, not a control state. */
  muted: boolean;
}

export function musicTransport(
  bot: VoiceMemberState | undefined,
  queue: MusicQueueState | null
): MusicTransport {
  return {
    present: Boolean(bot),
    playing: queue?.playing === true && queue.entries.length > 0,
    currentEntryId: queue?.entries[0]?.entryId ?? null,
    muted: bot?.moderation.muted === true
  };
}

/**
 * What the panel says when nobody has just asked for anything.
 *
 * The mute is said *while something is playing* and not otherwise. That is the
 * one state where it explains anything — the Queue says a Track is playing and
 * the room cannot hear it — and the one state where its sentence names an
 * action a member can take, because Pause is only offered for a Queue that is
 * running. Announcing a mute over a paused or empty Queue would point at a
 * control that is disabled or says the opposite.
 */
export function musicRestingKey(transport: MusicTransport): TranslationKey {
  if (transport.playing) return transport.muted ? "music.muted" : "music.playing";
  if (transport.currentEntryId) return "music.paused";
  return "music.idle";
}

/**
 * What Play/Pause asks for. One button, because pausing and resuming are the
 * two halves of one control and a member should never be shown both.
 */
export function transportToggleCommand(transport: MusicTransport): MusicCommand {
  return transport.playing ? { kind: "stop" } : { kind: "play" };
}

export function requestMusicCommand(
  socket: MusicSocket | null,
  roomId: string | null,
  command: MusicCommand
): Promise<MusicControlAck> {
  if (!socket || !roomId) {
    return Promise.resolve({ ok: false, error: "not_in_voice_room" } as const);
  }
  return new Promise((resolve) => {
    socket.emit("music:control", { roomId, command }, resolve);
  });
}

/**
 * Whether what a member typed is worth sending at all.
 *
 * Still only "is there something here", and now for a stronger reason than
 * before: the browser does not even decide whether this is a link to play or a
 * name to search for. That is the bot's answer and one field carries both
 * (ADR-0007), so a second opinion here would be the copy that drifts — refusing
 * a form the bot has since learned to accept, with no way for anyone to tell
 * why.
 */
export function isSendableInput(input: string) {
  return input.trim().length > 0;
}

/** A Track's length as a person reads it: 3:42, or 1:04:11 for a long one. */
export function trackLength(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  const parts = [Math.floor(whole / 3_600), Math.floor(whole / 60) % 60, whole % 60];
  return parts
    .slice(parts[0] === 0 ? 1 : 0)
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join(":");
}

/**
 * What the panel says once a Track has been accepted.
 *
 * "Added to the queue" whether it starts now or waits its turn: the Queue row
 * beneath says which, and one sentence that is always true beats two that have
 * to be chosen between. It exists for the live region — the link field clearing
 * is feedback a sighted member gets for free and a screen-reader user does not.
 */
export function trackAddedMessage(
  track: MusicTrackSummary,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
) {
  return t("music.queued", { title: track.title, length: trackLength(track.durationSeconds) });
}

/**
 * One Result a search offered, ready to render.
 *
 * **These belong to the one member who typed the name.** Everything else this
 * panel draws is read from the Queue the bot published to the room, so five
 * people see one thing; a list of Results is the opposite of that, and it
 * comes back on that member's own acknowledgement rather than through
 * `music:queue`. It is held in the component and nowhere else, it is never
 * merged into the room's state, and it goes as soon as one is chosen. ADR-0007
 * records the boundary, because the rule beside it says the opposite.
 */
export interface MusicResultRow {
  /**
   * What to send to play this one — the link the bot built, handed straight
   * back. The browser stores it and does not read it: which links are playable
   * is not its knowledge.
   */
  url: string;
  title: string;
  /** The Track's length as a person reads it — what tells an hour-long mix apart. */
  length: string;
  /** Who published it — what tells a cover apart. Empty if the source said none. */
  channel: string;
  /**
   * Whether this is the one on offer — the source's closest, and the one Enter
   * takes. Read rather than derived from focus: a member who submitted with the
   * pointer gets focus moved programmatically, which browsers deliberately do
   * not draw a focus ring for, so "which one is selected" would be invisible to
   * exactly the people who did not use the keyboard.
   */
  isClosest: boolean;
  /**
   * The whole row in one sentence, for the control's accessible name. A column
   * of buttons all called "Add" tells a screen-reader user nothing about which
   * Track they are choosing, exactly as a column called "Remove" does not.
   */
  label: string;
}

export function musicSearchRows(
  results: MusicSearchResult[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): MusicResultRow[] {
  return results.map((result, index) => {
    const title = result.track.title;
    const length = trackLength(result.track.durationSeconds);
    // A flat listing does not always name the channel, and a Track without one
    // is still perfectly playable — so the sentence loses the clause rather
    // than the row being withheld.
    const choice = result.channel
      ? t("music.chooseResult", { title, length, channel: result.channel })
      : t("music.chooseResultUnknown", { title, length });
    const isClosest = index === 0;
    return {
      url: result.url,
      title,
      length,
      channel: result.channel,
      isClosest,
      // The one on offer says so in its own name too, not only in its border.
      // Focus announces it to whoever arrived by keyboard; this is for the
      // reader who tabs back to the list, or who never left it.
      label: isClosest ? t("music.chooseClosest", { choice }) : choice
    };
  });
}

/**
 * One row of the Queue, ready to render.
 *
 * A pure function over the Queue the bot published and the members the browser
 * already has, following the pattern the voice controls and member selectors
 * already use: the component arranges these, it does not compute them.
 */
export interface MusicQueueRow {
  entryId: string;
  title: string;
  /** The Track's length as a person reads it. */
  length: string;
  /** The Requester's current nickname, or a stand-in if they are not here. */
  requester: string;
  /** Whether this is the Track the bot is playing or has paused. */
  isCurrent: boolean;
  /** 1-based place in the Queue. */
  position: number;
  /**
   * The row's own words for where it is — "Now playing", "Up next", "#4 in the
   * queue". Computed rather than styled, so the Track that is sounding is told
   * apart by something a member who cannot separate two greys can still read.
   */
  positionLabel: string;
}

/**
 * Resolves each Requester here, at the end that knows names.
 *
 * The bot publishes user ids: it is handed one with every request and never
 * sees the member list a person sees, while the browser is already holding this
 * room's members and rendering their current nicknames everywhere else. A name
 * copied onto the wire by the bot would be the copy that goes stale the moment
 * somebody renames themselves.
 *
 * A Requester who has left the room since is named by a stand-in rather than by
 * their id. Their id would be true and useless; the Track is still theirs and
 * nobody in the room can read a UUID.
 */
export function musicQueueRows(
  state: MusicQueueState | null,
  members: VoiceMemberState[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): MusicQueueRow[] {
  const nicknames = new Map(members.map((member) => [member.user.userId, member.user.nickname]));
  return (state?.entries ?? []).map((entry, index) => ({
    entryId: entry.entryId,
    title: entry.track.title,
    length: trackLength(entry.track.durationSeconds),
    requester: nicknames.get(entry.requestedByUserId) ?? t("music.requesterUnknown"),
    isCurrent: index === 0,
    position: index + 1,
    positionLabel: positionLabelFor(index, state?.playing ?? false, t)
  }));
}

/**
 * "Now playing" for the head of the Queue and "Up next" for the one behind it,
 * because those are the two a member is actually asking about. Everything after
 * that is numbered, which is what answers "how long until mine".
 *
 * The head reads "Paused" when the bot has stopped. That is what `playing` on
 * the published Queue is for, and without reading it here the panel would
 * announce a Track as playing while the room sat in silence.
 */
function positionLabelFor(
  index: number,
  playing: boolean,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
) {
  if (index === 0) return playing ? t("music.nowPlaying") : t("music.pausedTrack");
  if (index === 1) return t("music.upNext");
  return t("music.queuePosition", { position: index + 1 });
}

/**
 * One line of the Set log, ready to render.
 *
 * A whole sentence rather than the parts to assemble, which is the one thing
 * that differs from a Queue row. A Queue row is a Track, a length and a name in
 * fixed columns; a log line is a sentence about a member, and Turkish does not
 * put its words in English's order. Building it here means each language owns
 * its own, in one string, instead of having it stitched together in JSX.
 */
export interface MusicSetLogRow {
  lineId: string;
  message: string;
}

/**
 * What members have done during this Set, most recent first.
 *
 * **This is the room's, not one member's** — the opposite of a search's
 * Results, immediately above. Everyone in the channel must read the same
 * explanation for the same silence, or "Ada skipped Nocturne" answers four
 * people's question and not the fifth's. So it arrives inside the published
 * Queue, on the same message, and this reads it exactly as `musicQueueRows`
 * reads the entries. ADR-0008.
 *
 * Nicknames are resolved here for the same reason the Requester's is: the bot
 * publishes ids and never sees a member list, and a member who has left is
 * named by the same stand-in sentence rather than by an id nobody can read.
 */
export function musicSetLogRows(
  state: MusicQueueState | null,
  members: VoiceMemberState[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string
): MusicSetLogRow[] {
  const nicknames = new Map(members.map((member) => [member.user.userId, member.user.nickname]));
  return (state?.log ?? []).map((line) => ({
    lineId: line.lineId,
    message: t(setLogKey(line.action), {
      nickname: nicknames.get(line.requestedByUserId) ?? t("music.requesterUnknown"),
      // A pause and a resume carry no Track and their sentences do not name
      // one, so this is only ever read for the three verbs that do. A line that
      // should have carried a title and did not is a fault above; the answer to
      // it is a sentence that still reads rather than a gap in the middle of
      // one.
      title: line.trackTitle ?? t("music.logTrackUnknown")
    })
  }));
}

/**
 * Exhaustive on purpose, as the refusals are: a verb added to the contract
 * should fail the build here rather than render a member doing nothing.
 */
function setLogKey(action: MusicSetLogAction): TranslationKey {
  switch (action) {
    case "added":
      return "music.logAdded";
    case "skipped":
      return "music.logSkipped";
    case "removed":
      return "music.logRemoved";
    case "paused":
      return "music.logPaused";
    case "resumed":
      return "music.logResumed";
    default:
      return assertNever("Set log action", action);
  }
}

/**
 * The Queue for the room being looked at, or nothing.
 *
 * Nothing is the answer whenever the bot is not in the room: it is the bot that
 * owns the Queue, and a list left over from a Set that ended is a list of
 * Tracks nobody is going to hear. The room's own snapshot is what settles that,
 * exactly as it settles whether the bot is playing.
 */
export function musicQueueFor(
  queues: Record<string, MusicQueueState>,
  roomId: string | null,
  bot: VoiceMemberState | undefined
): MusicQueueState | null {
  if (!roomId || !bot) return null;
  return queues[roomId] ?? null;
}

/**
 * Every refusal gets its own sentence. "Nothing happened" is the worst possible
 * answer for a control whose whole output is sound somewhere else.
 */
export function musicErrorKey(error: MusicControlError): TranslationKey {
  switch (error) {
    case "bot_offline":
      return "music.errorOffline";
    case "no_music_bot":
      return "music.errorMissing";
    case "afk_room":
      return "music.errorAfk";
    case "not_in_voice_room":
      return "music.errorNotInRoom";
    case "room_not_found":
      return "music.errorRoom";
    case "unsupported_link":
      return "music.errorLink";
    case "track_unavailable":
      return "music.errorUnavailable";
    case "live_stream":
      return "music.errorLive";
    case "extractor_failed":
      return "music.errorSource";
    case "bot_timeout":
      return "music.errorTimeout";
    case "queue_full":
      return "music.errorQueueFull";
    case "bot_failed":
      return "music.errorBot";
    default:
      // Exhaustive on purpose rather than a catch-all: a refusal added to the
      // contract should fail the build here, not quietly render the wrong
      // sentence to someone wondering why nothing happened.
      return assertNever("music control error", error);
  }
}

/** One per file, naming what was unhandled, as the bot's modules do. */
function assertNever(what: string, value: never): never {
  throw new Error(`Unhandled ${what}: ${String(value)}`);
}
