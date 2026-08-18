import { applySharedAudioOutputToMediaElement } from "./audioOutput.js";
import { notificationSoundSources, type NotificationSoundKey } from "./notificationSounds.js";
import { volumeGain } from "./voiceVolume.js";

export interface NotificationSoundElement {
  volume: number;
  currentTime: number;
  play(): unknown;
  load?(): unknown;
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
  /**
   * Fetches and decodes every cue, and settles the output device on each
   * element, before any of them is needed. Playback latency is otherwise paid
   * on the first use of each cue — a network round trip for the file plus a
   * sink-selection round trip — which is exactly the moment the cue is supposed
   * to be reporting something that already happened.
   */
  prime(): void;
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
  // Tracks which elements have already had the chosen output device applied, so
  // a warm cue plays on the same tick instead of waiting on `setSinkId` again.
  const routed = new Set<NotificationSoundKey>();
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

  // The device is applied before playback so a cue never escapes to the system
  // default output after the listener chose a specific one. A missing file, a
  // revoked device, or a blocked autoplay policy all degrade to silence.
  const route = (key: NotificationSoundKey, element: NotificationSoundElement) => {
    if (routed.has(key)) return null;
    routed.add(key);
    return applyOutputDevice(element).catch(() => undefined);
  };

  const cue = (element: NotificationSoundElement, volume: number) => {
    element.volume = Math.min(1, volumeGain(volume));
    try {
      element.currentTime = 0;
    } catch {
      // Seeking before metadata loads throws in some browsers; the first play
      // already starts at zero.
    }
  };

  const start = (element: NotificationSoundElement) => {
    try {
      const started = element.play();
      if (started && typeof (started as Promise<void>).catch === "function") {
        void (started as Promise<void>).catch(() => undefined);
      }
    } catch {
      // A blocked autoplay policy degrades to silence.
    }
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
      cue(element, volume);
      const routing = route(key, element);
      // A cue that is already routed — which `prime` arranges for all of them —
      // starts synchronously. Deferring every play behind the sink promise added
      // a scheduling hop to sounds whose whole purpose is to land with the
      // action that triggered them.
      if (!routing) {
        start(element);
        return true;
      }
      void routing.then(() => { if (!disposed) start(element); });
      return true;
    },
    prime() {
      if (disposed) return;
      for (const key of Object.keys(notificationSoundSources) as NotificationSoundKey[]) {
        const element = elementFor(key);
        if (!element) continue;
        try {
          element.load?.();
        } catch {
          // Preloading is an optimisation; a browser that refuses it still
          // fetches the file on first play.
        }
        void route(key, element);
      }
    },
    dispose() {
      disposed = true;
      elements.clear();
      lastPlayedAt.clear();
      routed.clear();
    }
  };
}
