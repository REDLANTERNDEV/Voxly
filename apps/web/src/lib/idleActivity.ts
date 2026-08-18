import { DEFAULT_AFK_TIMEOUT_MINUTES } from "@voxly/shared";
import type { AfkTimeoutMinutes, RoomSummary } from "@voxly/shared";

/**
 * Idle detection for the AFK room.
 *
 * Deliberately measured in the browser rather than from socket liveness: a tab
 * that is open, connected, and completely untouched is exactly the case this
 * exists for, and the server cannot tell that apart from someone listening.
 */

/**
 * How often the threshold is re-checked. Long enough that a backgrounded tab's
 * throttled timers are not fighting it, short enough that the move lands within
 * a minute of the deadline.
 */
export const afkIdleCheckIntervalMs = 60_000;

/**
 * Anything that means a person is present. Pointer, keyboard, and touch cover
 * direct interaction; speaking is included because someone who talks for two
 * hours without touching the mouse is the opposite of away, and leaving it out
 * would park the most active person in the room.
 */
export const afkActivityEvents = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export interface AfkMoveInput {
  lastActivityAt: number;
  now: number;
  activeVoiceRoomId: string | null;
  afkRoomId: string | null;
  /** The owner's setting for the server the member is connected to. */
  timeoutMinutes: AfkTimeoutMinutes;
}

export function afkTimeoutMs(minutes: AfkTimeoutMinutes) {
  return minutes * 60_000;
}

/**
 * The timeout belongs to the server whose voice room the member occupies, which
 * is not necessarily the one they are looking at. A member browsing elsewhere
 * while connected must still be measured against the room they are actually in.
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
 * Only someone already in voice is moved. Being idle in a text channel is not
 * a state the AFK room can express, and joining voice on their behalf would be
 * taking an action they never asked for.
 */
export function shouldMoveToAfk(input: AfkMoveInput): boolean {
  if (!input.activeVoiceRoomId || !input.afkRoomId) return false;
  if (input.activeVoiceRoomId === input.afkRoomId) return false;
  return input.now - input.lastActivityAt >= afkTimeoutMs(input.timeoutMinutes);
}

/**
 * The AFK room belongs to the server whose voice room the member is in, which
 * is not necessarily the server they are looking at — voice outlives navigation
 * here. Resolution therefore goes through the accumulated cross-server indexes
 * rather than the active server's room list, which would come up empty for
 * anyone browsing elsewhere while connected.
 */
export function afkRoomIdFor(
  roomServerIds: Record<string, string>,
  afkRoomIdsByServer: Record<string, string>,
  activeVoiceRoomId: string | null
): string | null {
  if (!activeVoiceRoomId) return null;
  const serverId = roomServerIds[activeVoiceRoomId];
  if (!serverId) return null;
  return afkRoomIdsByServer[serverId] ?? null;
}

/**
 * Records one server's AFK room, or clears it when that server no longer has
 * one. Rebuilt from each full room list so a deleted AFK room does not leave an
 * id behind for the mover to aim at.
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
