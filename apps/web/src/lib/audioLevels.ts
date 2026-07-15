import { clampVolumePercent, type StorageLike } from "./voiceVolume.js";

export interface AudioLevels {
  input: number;
  output: number;
}

export const DEFAULT_AUDIO_LEVELS: AudioLevels = { input: 100, output: 100 };

export function audioLevelStorageKey(userId: string) {
  return `voxly:audio-levels:v1:${userId}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readAudioLevels(userId: string, storage = browserStorage()): AudioLevels {
  if (!storage) return { ...DEFAULT_AUDIO_LEVELS };
  try {
    const value: unknown = JSON.parse(storage.getItem(audioLevelStorageKey(userId)) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ...DEFAULT_AUDIO_LEVELS };
    }
    const candidate = value as Partial<AudioLevels>;
    return {
      input: typeof candidate.input === "number" ? clampVolumePercent(candidate.input) : DEFAULT_AUDIO_LEVELS.input,
      output: typeof candidate.output === "number" ? clampVolumePercent(candidate.output) : DEFAULT_AUDIO_LEVELS.output
    };
  } catch {
    return { ...DEFAULT_AUDIO_LEVELS };
  }
}

export function writeAudioLevels(userId: string, levels: AudioLevels, storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(audioLevelStorageKey(userId), JSON.stringify({
      input: clampVolumePercent(levels.input),
      output: clampVolumePercent(levels.output)
    }));
  } catch {
    return;
  }
}

export function combineOutputVolume(sourceVolume: number, outputVolume: number) {
  return clampVolumePercent((clampVolumePercent(sourceVolume) * clampVolumePercent(outputVolume)) / 100);
}
