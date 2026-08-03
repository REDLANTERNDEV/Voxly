import type { StorageLike } from "./voiceVolume.js";

// Browsers already enable noise suppression when `getUserMedia` leaves the
// constraint unspecified, so the stored default matches what capture did before
// the preference existed. Turning it off is the new capability.
export const DEFAULT_NOISE_SUPPRESSION = true;

export function noiseSuppressionStorageKey(userId: string) {
  return `voxly:noise-suppression:v1:${userId}`;
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readNoiseSuppression(userId: string, storage = browserStorage()): boolean {
  if (!storage) return DEFAULT_NOISE_SUPPRESSION;
  try {
    const value: unknown = JSON.parse(storage.getItem(noiseSuppressionStorageKey(userId)) ?? "null");
    return typeof value === "boolean" ? value : DEFAULT_NOISE_SUPPRESSION;
  } catch {
    return DEFAULT_NOISE_SUPPRESSION;
  }
}

export function writeNoiseSuppression(userId: string, enabled: boolean, storage = browserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(noiseSuppressionStorageKey(userId), JSON.stringify(enabled === true));
  } catch {
    return;
  }
}

export interface MicrophoneProcessingSettings {
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

// Automatic gain control rides with suppression. Left on over an unsuppressed
// signal it keeps re-riding the exposed noise floor between words, which pumps
// the voice itself; the manual input level covers the gain it used to provide.
export function microphoneProcessingConstraints(enabled: boolean): MicrophoneProcessingSettings {
  return { noiseSuppression: enabled, autoGainControl: enabled };
}

interface ReconfigurableTrack {
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
  getSettings(): MediaTrackSettings;
}

// Reconfiguring the live capture avoids reopening the device, which would reset
// the echo canceller and make it audibly re-converge. Browsers may resolve
// without actually reconfiguring, so the observed settings decide whether the
// caller still has to re-capture.
export async function applyMicrophoneProcessing(
  track: ReconfigurableTrack | null | undefined,
  enabled: boolean
) {
  if (typeof track?.applyConstraints !== "function" || typeof track.getSettings !== "function") {
    return false;
  }
  const wanted = microphoneProcessingConstraints(enabled);
  try {
    await track.applyConstraints(wanted);
    const settings = track.getSettings();
    return settings.noiseSuppression === wanted.noiseSuppression
      && settings.autoGainControl === wanted.autoGainControl;
  } catch {
    return false;
  }
}

export function supportsNoiseSuppression(
  supported: Partial<MediaTrackSupportedConstraints> | null | undefined
) {
  return supported?.noiseSuppression === true;
}

// `navigator.mediaDevices` is undefined on insecure origins and absent entirely
// outside the browser, so probing support must never throw.
export function browserSupportsNoiseSuppression() {
  try {
    if (typeof navigator === "undefined") return false;
    const getSupportedConstraints = navigator.mediaDevices?.getSupportedConstraints;
    if (typeof getSupportedConstraints !== "function") return false;
    return supportsNoiseSuppression(getSupportedConstraints.call(navigator.mediaDevices));
  } catch {
    return false;
  }
}
