import { clampVolumePercent, type StorageLike } from "./voiceVolume.js";

export type NotificationSoundKey =
  | "voiceJoin"
  | "voiceLeave"
  | "voicePeerJoin"
  | "voicePeerLeave"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "message"
  | "connectionLost"
  | "connectionRestored";

export type NotificationSoundCategory = "voice" | "message" | "connection";

export const notificationSoundCategories: Record<NotificationSoundKey, NotificationSoundCategory> = {
  voiceJoin: "voice",
  voiceLeave: "voice",
  voicePeerJoin: "voice",
  voicePeerLeave: "voice",
  mute: "voice",
  unmute: "voice",
  deafen: "voice",
  undeafen: "voice",
  message: "message",
  connectionLost: "connection",
  connectionRestored: "connection"
};

// The cues are static assets rather than generated tones so they can be
// replaced without touching playback code. Keep the file names stable; a
// missing file degrades to silence instead of failing the interaction.
export const notificationSoundSources: Record<NotificationSoundKey, string> = {
  voiceJoin: "/sounds/voice-join.wav",
  voiceLeave: "/sounds/voice-leave.wav",
  voicePeerJoin: "/sounds/voice-peer-join.wav",
  voicePeerLeave: "/sounds/voice-peer-leave.wav",
  mute: "/sounds/mute.wav",
  unmute: "/sounds/unmute.wav",
  deafen: "/sounds/deafen.wav",
  undeafen: "/sounds/undeafen.wav",
  message: "/sounds/message.wav",
  connectionLost: "/sounds/connection-lost.wav",
  connectionRestored: "/sounds/connection-restored.wav"
};

export interface NotificationSoundPreferences {
  enabled: boolean;
  volume: number;
  voice: boolean;
  message: boolean;
  connection: boolean;
}

export const MAX_NOTIFICATION_VOLUME_PERCENT = 100;

export const DEFAULT_NOTIFICATION_SOUNDS: NotificationSoundPreferences = {
  enabled: true,
  volume: 70,
  voice: true,
  message: true,
  connection: true
};

export function notificationSoundStorageKey(userId: string) {
  return `voxly:notification-sounds:v1:${userId}`;
}

export function clampNotificationVolume(value: number) {
  return Math.min(MAX_NOTIFICATION_VOLUME_PERCENT, clampVolumePercent(value));
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function readNotificationSounds(userId: string, storage = browserStorage()): NotificationSoundPreferences {
  if (!storage) return { ...DEFAULT_NOTIFICATION_SOUNDS };
  try {
    const value: unknown = JSON.parse(storage.getItem(notificationSoundStorageKey(userId)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...DEFAULT_NOTIFICATION_SOUNDS };
    }
    const candidate = value as Partial<NotificationSoundPreferences>;
    return {
      enabled: booleanOr(candidate.enabled, DEFAULT_NOTIFICATION_SOUNDS.enabled),
      volume: typeof candidate.volume === "number"
        ? clampNotificationVolume(candidate.volume)
        : DEFAULT_NOTIFICATION_SOUNDS.volume,
      voice: booleanOr(candidate.voice, DEFAULT_NOTIFICATION_SOUNDS.voice),
      message: booleanOr(candidate.message, DEFAULT_NOTIFICATION_SOUNDS.message),
      connection: booleanOr(candidate.connection, DEFAULT_NOTIFICATION_SOUNDS.connection)
    };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SOUNDS };
  }
}

export function writeNotificationSounds(
  userId: string,
  preferences: NotificationSoundPreferences,
  storage = browserStorage()
) {
  if (!storage) return;
  try {
    storage.setItem(notificationSoundStorageKey(userId), JSON.stringify({
      ...preferences,
      volume: clampNotificationVolume(preferences.volume)
    }));
  } catch {
    return;
  }
}

// Deafen silences what the room produces, so cues stay silent with it. The two
// deafen cues are the exception because they report leaving or entering that
// state and would otherwise give no feedback at all.
export function notificationSoundAllowed(
  key: NotificationSoundKey,
  preferences: NotificationSoundPreferences,
  state: { deafened: boolean }
) {
  if (!preferences.enabled) return false;
  if (!preferences[notificationSoundCategories[key]]) return false;
  if (state.deafened && key !== "deafen" && key !== "undeafen") return false;
  return true;
}

export function shouldPlayMessageSound(
  message: { roomId: string; userId: string },
  context: { currentUserId: string; activeTextRoomId: string | null; windowFocused: boolean }
) {
  if (message.userId === context.currentUserId) return false;
  return message.roomId !== context.activeTextRoomId || !context.windowFocused;
}

export interface VoiceRosterState {
  roomId: string | null;
  seeded: boolean;
  userIds: string[];
}

export const EMPTY_VOICE_ROSTER: VoiceRosterState = { roomId: null, seeded: false, userIds: [] };

export function voiceRosterTransitions(previous: readonly string[], next: readonly string[]) {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    joined: next.filter((userId) => !before.has(userId)),
    left: previous.filter((userId) => !after.has(userId))
  };
}

// A room change or a first snapshot only establishes the baseline. Without that
// rule the snapshot that arrives with a join would announce every participant
// already in the room.
export function advanceVoiceRoster(
  previous: VoiceRosterState,
  next: { roomId: string | null; userIds: readonly string[] | null }
): { state: VoiceRosterState; joined: string[]; left: string[] } {
  const seeded = next.roomId !== null && next.userIds !== null;
  const state: VoiceRosterState = { roomId: next.roomId, seeded, userIds: [...(next.userIds ?? [])] };
  if (!seeded || !previous.seeded || previous.roomId !== next.roomId) {
    return { state, joined: [], left: [] };
  }
  return { state, ...voiceRosterTransitions(previous.userIds, state.userIds) };
}
