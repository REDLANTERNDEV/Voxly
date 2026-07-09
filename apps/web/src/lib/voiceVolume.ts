export const DEFAULT_VOLUME_PERCENT = 100;
export const MIN_VOLUME_PERCENT = 0;
export const MAX_VOLUME_PERCENT = 200;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampVolumePercent(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_VOLUME_PERCENT;
  }

  return Math.min(MAX_VOLUME_PERCENT, Math.max(MIN_VOLUME_PERCENT, Math.round(value)));
}

export function volumeGain(value: number) {
  return clampVolumePercent(value) / DEFAULT_VOLUME_PERCENT;
}

export function userVolumeStorageKey(listenerUserId: string) {
  return `voxly:voice-volumes:v1:${listenerUserId}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readUserVolumes(listenerUserId: string, storage = browserStorage()): Record<string, number> {
  if (!storage) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(storage.getItem(userVolumeStorageKey(listenerUserId)) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value).flatMap(([userId, volume]) => (
        typeof volume === "number" && Number.isFinite(volume)
          ? [[userId, clampVolumePercent(volume)]]
          : []
      ))
    );
  } catch {
    return {};
  }
}

export function writeUserVolumes(listenerUserId: string, volumes: Record<string, number>, storage = browserStorage()) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(userVolumeStorageKey(listenerUserId), JSON.stringify(volumes));
  } catch {
    return;
  }
}

export function setVolume(volumes: Record<string, number>, id: string, volume: number) {
  return { ...volumes, [id]: clampVolumePercent(volume) };
}

export function pruneVolumes(volumes: Record<string, number>, activeIds: Iterable<string>) {
  const active = new Set(activeIds);
  return Object.fromEntries(Object.entries(volumes).filter(([id]) => active.has(id)));
}
