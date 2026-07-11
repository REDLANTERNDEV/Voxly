import {
  applyAudioOutputDevice,
  supportsAudioOutputSelection,
  type AudioOutputApplication
} from "./audioDevices.js";

let sharedContext: AudioContext | null = null;
let activeOutputs = 0;
let listenersAttached = false;
let selectedOutputDeviceId = "";
let outputSelectionGeneration = 0;
let outputSelectionQueue: Promise<AudioOutputApplication> = Promise.resolve("unsupported");

type SinkAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<unknown> };

function resumeSharedContext() {
  void sharedContext?.resume().catch(() => undefined);
}

function getContext() {
  if (sharedContext) return sharedContext;
  if (!window.AudioContext) return null;
  try {
    sharedContext = new window.AudioContext();
    void applyAudioOutputDevice(selectedOutputDeviceId, { audioContext: sharedContext as SinkAudioContext }).catch(() => undefined);
    return sharedContext;
  } catch {
    return null;
  }
}

function attachResumeListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener("pointerdown", resumeSharedContext, { passive: true });
  window.addEventListener("keydown", resumeSharedContext);
}

function detachResumeListeners() {
  if (!listenersAttached) return;
  listenersAttached = false;
  window.removeEventListener("pointerdown", resumeSharedContext);
  window.removeEventListener("keydown", resumeSharedContext);
}

export type AudioOutput = {
  setVolume: (muted: boolean, volume: number) => void;
  dispose: () => void;
};

export function sharedAudioOutputSelectionSupported(mediaElements: readonly HTMLMediaElement[] = []) {
  if (typeof window === "undefined") return false;
  const AudioContextClass = window.AudioContext;
  const audioContextPrototype = AudioContextClass?.prototype as SinkAudioContext | undefined;
  return supportsAudioOutputSelection({
    audioContext: audioContextPrototype,
    mediaElements: mediaElements.length > 0 ? mediaElements : [window.HTMLMediaElement?.prototype].filter(Boolean) as HTMLMediaElement[]
  });
}

export function applySharedAudioOutputToMediaElement(element: HTMLMediaElement) {
  return applyAudioOutputDevice(selectedOutputDeviceId, { mediaElements: [element] });
}

export async function selectSharedAudioOutputDevice(
  deviceId: string,
  mediaElements: readonly HTMLMediaElement[] = []
): Promise<AudioOutputApplication> {
  const generation = ++outputSelectionGeneration;
  selectedOutputDeviceId = deviceId;
  outputSelectionQueue = outputSelectionQueue.catch(() => "unsupported").then(async () => {
    const isCurrentSelection = generation === outputSelectionGeneration;
    const effectiveDeviceId = isCurrentSelection ? deviceId : selectedOutputDeviceId;
    const effectiveElements = isCurrentSelection ? mediaElements : [];
    if (sharedContext) {
      return applyAudioOutputDevice(effectiveDeviceId, { audioContext: sharedContext as SinkAudioContext, mediaElements: effectiveElements });
    }
    if (sharedAudioOutputSelectionSupported()) return "audio-context";
    return applyAudioOutputDevice(effectiveDeviceId, { mediaElements: effectiveElements });
  });
  return outputSelectionQueue;
}

export function connectAudioOutput(stream: MediaStream): AudioOutput | null {
  const context = getContext();
  if (!context) return null;
  try {
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    activeOutputs += 1;
    attachResumeListeners();
    resumeSharedContext();
    let disposed = false;
    return {
      setVolume(muted, volume) {
        gain.gain.value = muted ? 0 : Math.max(0, Math.min(1, volume / 100));
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        source.disconnect();
        gain.disconnect();
        activeOutputs = Math.max(0, activeOutputs - 1);
        if (activeOutputs === 0) {
          detachResumeListeners();
          const closingContext = sharedContext;
          sharedContext = null;
          void closingContext?.close().catch(() => undefined);
        }
      }
    };
  } catch {
    return null;
  }
}
