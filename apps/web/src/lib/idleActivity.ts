import { DEFAULT_AFK_TIMEOUT_MINUTES } from "@voxly/shared";
import type { AfkTimeoutMinutes, RoomSummary } from "@voxly/shared";

/**
 * Idle detection.
 *
 * Deliberately measured in the browser rather than from socket liveness: a tab
 * that is open, connected, and completely untouched is exactly the case this
 * exists for, and the server cannot tell that apart from someone listening.
 *
 * What it drives is a presence dot and nothing else. The browser sees only its
 * own window, so a member playing a fullscreen game with a muted microphone is
 * indistinguishable from one who walked away, and no threshold separates them.
 * That makes this a signal to display, not one to act on.
 */

/**
 * How often the threshold is re-checked. Long enough that a backgrounded tab's
 * throttled timers are not fighting it, short enough that the dot turns within
 * a minute of the deadline.
 */
export const afkIdleCheckIntervalMs = 60_000;

/**
 * Anything that means a person is present. Pointer, keyboard, and touch cover
 * direct interaction; speaking is reported separately by the caller, because
 * someone who talks for an hour without touching the mouse is the opposite of
 * away.
 */
export const afkActivityEvents = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export function afkTimeoutMs(minutes: AfkTimeoutMinutes) {
  return minutes * 60_000;
}

/**
 * The threshold belongs to the server whose voice room the member occupies,
 * which is not necessarily the one they are looking at — voice outlives
 * navigation here. Resolution therefore goes through the accumulated
 * cross-server index rather than the active server's room list, which would
 * come up empty for anyone browsing elsewhere while connected.
 */
export function afkTimeoutFor(
  roomServerIds: Record<string, string>,
  timeoutsByServer: Record<string, AfkTimeoutMinutes>,
  activeVoiceRoomId: string | null
): AfkTimeoutMinutes {
  if (!activeVoiceRoomId) return DEFAULT_AFK_TIMEOUT_MINUTES;
  const serverId = roomServerIds[activeVoiceRoomId];
  return (serverId && timeoutsByServer[serverId]) || DEFAULT_AFK_TIMEOUT_MINUTES;
}

/**
 * Records one server's AFK room, or clears it when that server no longer has
 * one. Rebuilt from each full room list so a deleted AFK room leaves no id
 * behind for the microphone lock to key off.
 */
export function indexAfkRoom(
  afkRoomIdsByServer: Record<string, string>,
  serverId: string,
  rooms: RoomSummary[]
) {
  const afkRoom = rooms.find((room) => room.isAfk && room.kind === "voice" && room.serverId === serverId);
  if (afkRoom) afkRoomIdsByServer[serverId] = afkRoom.id;
  else delete afkRoomIdsByServer[serverId];
}
