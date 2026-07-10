let sharedContext: AudioContext | null = null;
let activeOutputs = 0;
let listenersAttached = false;

function resumeSharedContext() {
  void sharedContext?.resume().catch(() => undefined);
}

function getContext() {
  if (sharedContext) return sharedContext;
  if (!window.AudioContext) return null;
  try {
    sharedContext = new window.AudioContext();
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
