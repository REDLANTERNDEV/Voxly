import { applySharedAudioOutputToMediaElement } from "./audioOutput.js";
import { notificationSoundSources, type NotificationSoundKey } from "./notificationSounds.js";
import { volumeGain } from "./voiceVolume.js";

export interface NotificationSoundElement {
  volume: number;
  currentTime: number;
  play(): unknown;
}

// Bursts of joins or messages arrive within a few frames. Restarting the same
// cue that fast only produces a click, so a repeat inside this window is
// dropped instead of cutting the sound already playing. Keep it at or above the
// longest cue in `public/sounds` so no repeat truncates the one still ringing.
export const NOTIFICATION_SOUND_REPLAY_MS = 500;

export interface NotificationSoundPlayerOptions {
  createElement?: (source: string) => NotificationSoundElement | null;
  applyOutputDevice?: (element: NotificationSoundElement) => Promise<unknown>;
  now?: () => number;
}

export interface NotificationSoundPlayer {
  play(key: NotificationSoundKey, volume: number): boolean;
  dispose(): void;
}

function defaultCreateElement(source: string): NotificationSoundElement | null {
  if (typeof Audio === "undefined") return null;
  const element = new Audio(source);
  element.preload = "auto";
  return element;
}

function defaultApplyOutputDevice(element: NotificationSoundElement) {
  if (typeof HTMLAudioElement === "undefined" || !(element instanceof HTMLAudioElement)) {
    return Promise.resolve("unsupported" as const);
  }
  return applySharedAudioOutputToMediaElement(element);
}

export function createNotificationSoundPlayer(
  options: NotificationSoundPlayerOptions = {}
): NotificationSoundPlayer {
  const createElement = options.createElement ?? defaultCreateElement;
  const applyOutputDevice = options.applyOutputDevice ?? defaultApplyOutputDevice;
  const now = options.now ?? (() => Date.now());
  const elements = new Map<NotificationSoundKey, NotificationSoundElement | null>();
  const lastPlayedAt = new Map<NotificationSoundKey, number>();
  let disposed = false;

  const elementFor = (key: NotificationSoundKey) => {
    if (elements.has(key)) return elements.get(key) ?? null;
    let element: NotificationSoundElement | null = null;
    try {
      element = createElement(notificationSoundSources[key]);
    } catch {
      element = null;
    }
    elements.set(key, element);
    return element;
  };

  return {
    play(key, volume) {
      if (disposed) return false;
      const at = now();
      const previous = lastPlayedAt.get(key);
      if (previous !== undefined && at - previous < NOTIFICATION_SOUND_REPLAY_MS) return false;
      const element = elementFor(key);
      if (!element) return false;
      lastPlayedAt.set(key, at);
      element.volume = Math.min(1, volumeGain(volume));
      try {
        element.currentTime = 0;
      } catch {
        // Seeking before metadata loads throws in some browsers; the first play
        // already starts at zero.
      }
      // The device is applied before playback so a cue never escapes to the
      // system default output after the listener chose a specific one. A
      // missing file, a revoked device, or a blocked autoplay policy all
      // degrade to silence.
      void applyOutputDevice(element)
        .catch(() => undefined)
        .then(() => { if (!disposed) return element.play(); })
        .catch(() => undefined);
      return true;
    },
    dispose() {
      disposed = true;
      elements.clear();
      lastPlayedAt.clear();
    }
  };
}
