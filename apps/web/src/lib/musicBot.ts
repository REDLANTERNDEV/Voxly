/**
 * The Music bot as the browser sees it.
 *
 * The client never decides what the bot may do — the server authorizes a
 * request and the bot carries it out. What lives here is only what the browser
 * needs to draw the control: whether a bot is in the room, whether it is
 * playing, and what to say when the server refuses.
 */

import type { MusicCommand, MusicControlAck, MusicControlError, MusicTrackSummary, VoiceMemberState } from "@voxly/shared";
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
 * What the Music panel is looking at.
 *
 * `muted` is its own state rather than a kind of idle, and the distinction is
 * not cosmetic. The server clamps `speaking` to false for a muted member, but
 * media is peer-to-peer so the mute does not actually stop the bot's packets —
 * it may well still be audible. Folding that into "idle" would offer Play for
 * a bot that is already playing, and pressing it would do nothing at all.
 */
export type MusicPanelState = "absent" | "idle" | "playing" | "muted";

export function musicPanelState(bot: VoiceMemberState | undefined): MusicPanelState {
  if (!bot) return "absent";
  if (bot.moderation.muted) return "muted";
  return bot.media.speaking ? "playing" : "idle";
}

/**
 * Whether the control should offer to stop rather than to start. A muted bot
 * counts: stopping is the one request that is always safe to make and always
 * takes effect, so it is what a member is offered when nobody can tell from
 * here whether sound is still going out.
 */
export function offersStop(state: MusicPanelState) {
  return state === "playing" || state === "muted";
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
 * Whether a pasted link is worth sending at all.
 *
 * Deliberately only "is there something here": which links are playable is the
 * bot's knowledge, and a second opinion in the browser would be the copy that
 * drifts — refusing a form the bot has since learned to accept, with no way for
 * anyone to tell why.
 */
export function isSendableLink(input: string) {
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

/** What the panel says once a Track has been accepted. */
export function trackAddedMessage(track: MusicTrackSummary, t: (key: TranslationKey, values?: Record<string, string | number>) => string) {
  return t("music.added", { title: track.title, length: trackLength(track.durationSeconds) });
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
    case "bot_failed":
      return "music.errorBot";
    default:
      // Exhaustive on purpose rather than a catch-all: a refusal added to the
      // contract should fail the build here, not quietly render the wrong
      // sentence to someone wondering why nothing happened.
      return assertNever(error);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled music control error: ${String(value)}`);
}
