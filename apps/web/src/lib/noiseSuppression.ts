import { buildMicrophoneConstraints } from "./audioDevices.js";
import type { StorageLike } from "./voiceVolume.js";

// Browsers keep their native noise suppression enabled in the capture
// constraints. Voxly's additional spectral filter is opt-in because applying
// both layers by default can make some microphones sound metallic or crackly.
export const DEFAULT_NOISE_SUPPRESSION = false;

export function noiseSuppressionStorageKey(userId: string) {
  return `voxly:noise-suppression:v2:${userId}`;
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

// Capture processing is now fixed rather than following the preference.
//
// The constraint was never a control we could offer. Chrome runs one audio
// processing module per capture and echo cancellation engages it, so
// `noiseSuppression: false` does not reliably disengage the suppressor inside
// it — the toggle changed nothing audible on the browser most people use. It
// also cannot be changed on a live track, so honouring it meant releasing the
// device and reopening it, which is why a toggle took seconds and could leave
// the capture unrecoverable if the reopen failed.
//
// So the browser keeps its own baseline permanently on, and the preference
// drives the suppression stage in the capture graph instead, where it applies
// on the next audio block. See `noiseGate.ts`.
//
// Echo cancellation stays on so speaker users never hear themselves back.
// Automatic gain control stays on because the manual input level tops out at
// +6 dB while browsers apply well past that. All three are stated rather than
// left implicit: browsers hand every capture of one device the same pipeline,
// so two capture sites that request different sets silently resolve to
// whichever opened first.
export function microphoneProcessingConstraints(): MicrophoneProcessingSettings {
  return { noiseSuppression: true, autoGainControl: true, echoCancellation: true };
}

export interface MicrophoneCaptureSettings {
  deviceId: string;
}

// Only the device can require a reopen now. Suppression is applied in the
// capture graph, so changing it never disturbs the capture.
export type MicrophoneCaptureChange = "none" | "device";

export function microphoneCaptureChange(
  applied: MicrophoneCaptureSettings,
  next: MicrophoneCaptureSettings
): MicrophoneCaptureChange {
  return applied.deviceId !== next.deviceId ? "device" : "none";
}

interface MicrophoneCaptureSource {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MicrophoneCaptureOpenOptions {
  // Stops the capture that currently holds the device, for the callers that
  // have one. Ignored when opening a device nothing holds yet.
  release?: (() => void) | null;
  mediaDevices?: MicrophoneCaptureSource;
}

export async function openMicrophoneCapture(
  settings: MicrophoneCaptureSettings,
  { release, mediaDevices = navigator.mediaDevices }: MicrophoneCaptureOpenOptions = {}
) {
  release?.();
  return mediaDevices.getUserMedia(
    buildMicrophoneConstraints(settings.deviceId, microphoneProcessingConstraints())
  );
}

// Support now means "can we build the suppression stage", not "does this
// browser advertise the capture constraint". The constraint is requested
// unconditionally and its presence says nothing about whether the preference
// can be honoured; a Web Audio graph is what actually carries it.
export function supportsNoiseSuppression(
  audioContextAvailable: boolean
) {
  return audioContextAvailable === true;
}

// `window` is absent outside the browser, so probing support must never throw.
export function browserSupportsNoiseSuppression() {
  try {
    if (typeof window === "undefined") return false;
    const candidate = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
    return supportsNoiseSuppression(
      typeof candidate.AudioContext === "function" || typeof candidate.webkitAudioContext === "function"
    );
  } catch {
    return false;
  }
}
