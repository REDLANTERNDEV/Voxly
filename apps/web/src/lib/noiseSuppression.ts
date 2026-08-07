import { buildMicrophoneConstraints } from "./audioDevices.js";
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
  echoCancellation: boolean;
}

// Automatic gain control rides with suppression. Left on over an unsuppressed
// signal it keeps re-riding the exposed noise floor between words, which pumps
// the voice itself; the manual input level covers the gain it used to provide.
//
// Echo cancellation stays on either way so speaker users never hear themselves
// back, but it is stated rather than left implicit: browsers hand every capture
// of one device the same processing pipeline, so two capture sites that request
// different sets silently resolve to whichever opened first.
export function microphoneProcessingConstraints(enabled: boolean): MicrophoneProcessingSettings {
  return { noiseSuppression: enabled, autoGainControl: enabled, echoCancellation: true };
}

export interface MicrophoneCaptureSettings {
  deviceId: string;
  noiseSuppression: boolean;
}

export type MicrophoneCaptureChange = "none" | "device" | "processing";

export function microphoneCaptureChange(
  applied: MicrophoneCaptureSettings,
  next: MicrophoneCaptureSettings
): MicrophoneCaptureChange {
  if (applied.deviceId !== next.deviceId) return "device";
  if (applied.noiseSuppression !== next.noiseSuppression) return "processing";
  return "none";
}

interface MicrophoneCaptureSource {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MicrophoneCaptureOpenOptions {
  // Stops the capture that currently holds the device. Required whenever only
  // the processing changed, ignored when opening a device nothing holds yet.
  release?: (() => void) | null;
  mediaDevices?: MicrophoneCaptureSource;
}

// Processing is fixed when the device is opened. Asking a live track to change
// it is not reliable: `applyConstraints` resolves and `getSettings` then reports
// the requested values whether or not the running capture was reconfigured, so
// there is no answer to read back — the settings echo the request, not the
// audio. Reopening is the only way to change processing, and it only works on a
// device nothing else holds, because a second capture of an open device is
// served from the pipeline already running and its constraints are dropped.
// Releasing first is therefore part of opening rather than something each
// caller is trusted to remember.
export async function openMicrophoneCapture(
  settings: MicrophoneCaptureSettings,
  { release, mediaDevices = navigator.mediaDevices }: MicrophoneCaptureOpenOptions = {}
) {
  release?.();
  return mediaDevices.getUserMedia(
    buildMicrophoneConstraints(settings.deviceId, microphoneProcessingConstraints(settings.noiseSuppression))
  );
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
