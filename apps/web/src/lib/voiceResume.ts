import type { VisualTarget } from "@voxly/shared";

export const voiceResumeStorageKey = "voxly:voice-resume";
export const voiceResumeWindowMs = 10 * 60 * 1000;

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface StoredVoiceResume {
  expiresAt: number;
  roomId: string;
  targets: VisualTarget[];
}

export function writeVoiceResume(
  storage: StorageLike,
  roomId: string,
  targets: VisualTarget[],
  now = Date.now(),
  expiresAt = now + voiceResumeWindowMs
) {
  const value: StoredVoiceResume = {
    expiresAt,
    roomId,
    targets: uniqueVisualTargets(targets)
  };
  storage.setItem(voiceResumeStorageKey, JSON.stringify(value));
}

export function readVoiceResume(storage: StorageLike, now = Date.now()) {
  const raw = storage.getItem(voiceResumeStorageKey);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw) as Partial<StoredVoiceResume>;
    if (
      typeof value.roomId !== "string" ||
      !value.roomId ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= now ||
      !Array.isArray(value.targets) ||
      !value.targets.every(isVisualTarget)
    ) {
      storage.removeItem(voiceResumeStorageKey);
      return null;
    }
    return { expiresAt: value.expiresAt, roomId: value.roomId, targets: uniqueVisualTargets(value.targets) };
  } catch {
    storage.removeItem(voiceResumeStorageKey);
    return null;
  }
}

export function clearVoiceResume(storage: StorageLike) {
  storage.removeItem(voiceResumeStorageKey);
}

export function replaceVisualTarget(_current: VisualTarget[], target: VisualTarget) {
  return [target];
}

export function toggleVisualTarget(current: VisualTarget[], target: VisualTarget) {
  const key = visualTargetKey(target);
  const existing = uniqueVisualTargets(current);
  return existing.some((item) => visualTargetKey(item) === key)
    ? existing.filter((item) => visualTargetKey(item) !== key)
    : [...existing, target];
}

export function visualTargetKey(target: VisualTarget) {
  return `${target.publisherUserId}:${target.kind}`;
}

function uniqueVisualTargets(targets: VisualTarget[]) {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = visualTargetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isVisualTarget(value: unknown): value is VisualTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<VisualTarget>;
  return typeof target.publisherUserId === "string" && (target.kind === "camera" || target.kind === "screen");
}
