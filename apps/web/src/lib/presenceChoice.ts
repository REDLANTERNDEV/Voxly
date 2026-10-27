import {
  presenceDurationOptions,
  type PresenceChoice,
  type PresenceChoiceRequest,
  type PresenceDurationMinutes,
  type PresenceStatus
} from "@voxly/shared";
import type { MemberPresenceState } from "./memberDirectory.js";

/**
 * The Status a member picked, and what it means for their own Device.
 *
 * The server holds the Status and decides what everyone else sees; this module
 * only answers the two questions the member's own client asks of it: which dot
 * to draw on their own avatar, and whether a message may make a sound.
 */

export const presenceChoices = ["online", "idle", "dnd", "invisible"] as const satisfies readonly PresenceChoice[];

/** The durations offered for every Status except Online, in menu order; null is Forever. */
export const presenceDurations: ReadonlyArray<PresenceDurationMinutes | null> = [...presenceDurationOptions, null];

const durationKeys = {
  15: "presence.for15m",
  60: "presence.for1h",
  480: "presence.for8h",
  1440: "presence.for24h",
  4320: "presence.for3d"
} as const satisfies Record<PresenceDurationMinutes, string>;

export function presenceDurationKey(minutes: PresenceDurationMinutes | null) {
  return minutes === null ? "presence.forever" : durationKeys[minutes];
}

export function presenceChoiceRequest(
  status: PresenceChoice,
  minutes: PresenceDurationMinutes | null
): PresenceChoiceRequest {
  if (status === "online") return { status };
  return {
    status,
    duration: minutes === null ? { mode: "indefinite" } : { mode: "timed", durationMinutes: minutes }
  };
}

/**
 * The dot on the member's own avatar. A picked Status wins; with Online picked,
 * the dot follows what the server measured, so the member sees the idle that
 * everyone else sees. Invisible is shown only to its owner, who would otherwise
 * read their own grey dot as a lost connection.
 */
export function selfPresenceState(choice: PresenceChoice, measured: PresenceStatus | undefined): MemberPresenceState {
  if (choice !== "online") return choice;
  return measured === "idle" ? "idle" : "online";
}

/** Do Not Disturb silences messages, mentions included; a call keeps its own cues. */
export function presenceChoiceSilencesMessages(choice: PresenceChoice) {
  return choice === "dnd";
}
