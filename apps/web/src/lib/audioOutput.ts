import { applyAudioOutputDevice, supportsAudioOutputSelection, type AudioOutputApplication } from "./audioDevices.js";
import { DEFAULT_VOLUME_PERCENT, volumeGain } from "./voiceVolume.js";

let sharedContext: AudioContext | null = null;
let sharedContextHeld = false;
let activeOutputs = 0;
let listenersAttached = false;
let selectedOutputDeviceId = "";
let outputSelectionGeneration = 0;
let outputSelectionQueue: Promise<AudioOutputApplication> = Promise.resolve("unsupported");

type BoostGraph = {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

type ManagedAudioOutput = AudioOutput & {
  element: HTMLAudioElement;
  readonly nativePlaybackBlocked: boolean;
  refreshBoost: (forceRebuild?: boolean) => void;
};

type SinkAudioContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<unknown> };

const boostGainRampSeconds = 0.025;

const managedOutputs = new Set<ManagedAudioOutput>();
const blockedOutputs = new Set<ManagedAudioOutput>();
const blockedListeners = new Set<(blocked: boolean) => void>();
let lastBlockedState = false;

function resumeSharedContext() {
  void sharedContext?.resume().catch(() => undefined);
}

function resumeAudioOutputs() {
  resumeSharedContext();
  // A newly arrived peer can be blocked long after the voice join gesture.
  // Call play synchronously inside this activation, before any await.
  void retryBlockedAudioOutputs();
}

function refreshManagedBoosts() {
  for (const output of managedOutputs) output.refreshBoost();
}

function getContext() {
  if (sharedContext) return sharedContext;
  const AudioContextClass =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    try {
      sharedContext = new AudioContextClass({ sampleRate: 48000 });
    } catch {
      sharedContext = new AudioContextClass();
    }
    sharedContext.addEventListener?.("statechange", refreshManagedBoosts);
    return sharedContext;
  } catch {
    return null;
  }
}

export function unlockSharedAudioOutput() {
  const context = getContext();
  if (!context) return false;
  sharedContextHeld = true;
  attachResumeListeners();
  resumeSharedContext();
  return true;
}

export function releaseUnusedSharedAudioOutput() {
  sharedContextHeld = false;
  if (activeOutputs > 0) return false;
  detachResumeListeners();
  if (!sharedContext) return false;
  const context = sharedContext;
  sharedContext = null;
  context.removeEventListener?.("statechange", refreshManagedBoosts);
  void context.close().catch(() => undefined);
  return true;
}

function attachResumeListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener("pointerdown", resumeAudioOutputs, { passive: true });
  window.addEventListener("keydown", resumeAudioOutputs);
}

function detachResumeListeners() {
  if (!listenersAttached) return;
  listenersAttached = false;
  window.removeEventListener("pointerdown", resumeAudioOutputs);
  window.removeEventListener("keydown", resumeAudioOutputs);
}

export type AudioOutput = {
  ready: Promise<void>;
  setVolume: (muted: boolean, volume: number) => void;
  retry: () => Promise<boolean>;
  dispose: () => void;
};

export function sharedAudioOutputSelectionSupported(mediaElements: readonly HTMLMediaElement[] = []) {
  if (typeof window === "undefined") return false;
  const fallbackElements = [window.HTMLMediaElement?.prototype].filter((element): element is HTMLMediaElement =>
    Boolean(element)
  );
  return supportsAudioOutputSelection({
    mediaElements: mediaElements.length > 0 ? mediaElements : fallbackElements
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
  outputSelectionQueue = outputSelectionQueue
    .catch(() => "unsupported")
    .then(async () => {
      const elements = [...new Set([...[...managedOutputs].map((output) => output.element), ...mediaElements])];
      const supported = sharedAudioOutputSelectionSupported(elements);
      if (!supported) {
        if (generation === outputSelectionGeneration) selectedOutputDeviceId = deviceId;
        return "unsupported";
      }
      if (elements.length === 0) {
        if (generation === outputSelectionGeneration) selectedOutputDeviceId = deviceId;
        return "media-elements";
      }
      const result = await applyAudioOutputDevice(deviceId, { mediaElements: elements });
      if (generation === outputSelectionGeneration) {
        selectedOutputDeviceId = deviceId;
        for (const output of managedOutputs) output.refreshBoost(true);
      }
      return result;
    });
  return outputSelectionQueue;
}

export function subscribeBlockedAudioOutputs(listener: (blocked: boolean) => void) {
  blockedListeners.add(listener);
  listener(blockedOutputs.size > 0);
  return () => {
    blockedListeners.delete(listener);
  };
}

export async function retryBlockedAudioOutputs() {
  const outputs = [...managedOutputs].filter((output) => output.nativePlaybackBlocked);
  const results = await Promise.all(outputs.map((output) => output.retry()));
  return results.every(Boolean) && blockedOutputs.size === 0;
}

function publishBlockedState() {
  const next = blockedOutputs.size > 0;
  if (next === lastBlockedState) return;
  lastBlockedState = next;
  for (const listener of blockedListeners) listener(next);
}

function setOutputBlocked(output: ManagedAudioOutput, blocked: boolean) {
  if (blocked) blockedOutputs.add(output);
  else blockedOutputs.delete(output);
  publishBlockedState();
}

async function applySharedAudioOutputToContext(context: AudioContext) {
  const sinkContext = context as SinkAudioContext;
  if (!selectedOutputDeviceId) {
    if (typeof sinkContext.setSinkId === "function") {
      await sinkContext.setSinkId("").catch(() => undefined);
    }
    return true;
  }
  if (typeof sinkContext.setSinkId !== "function") return false;
  try {
    await sinkContext.setSinkId(selectedOutputDeviceId);
    return true;
  } catch {
    return false;
  }
}

function applyBoostGain(context: AudioContext, gain: AudioParam, volume: number) {
  const target = volumeGain(volume);
  const now = context.currentTime;
  if (
    Number.isFinite(now) &&
    typeof gain.cancelScheduledValues === "function" &&
    typeof gain.setValueAtTime === "function" &&
    typeof gain.linearRampToValueAtTime === "function"
  ) {
    const current = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(current, now);
    gain.linearRampToValueAtTime(target, now + boostGainRampSeconds);
    return;
  }
  gain.value = target;
}

export function connectAudioOutput(
  element: HTMLAudioElement,
  stream: MediaStream,
  initialState: { muted: boolean; volume: number } = { muted: false, volume: DEFAULT_VOLUME_PERCENT }
): AudioOutput {
  let state = initialState;
  let disposed = false;
  let generation = 0;
  let boostGraph: BoostGraph | null = null;
  let hasPlayed = false;
  let sinkApplied = false;
  let playAttempt: Promise<boolean> | null = null;
  let nativePlaybackBlocked = false;

  const needsGraph = () => !state.muted && (state.volume > 100 || nativePlaybackBlocked);

  const applyDirectState = () => {
    const switched = element.srcObject !== stream;
    if (switched) element.srcObject = stream;
    element.muted = state.muted;
    element.volume = Math.min(1, volumeGain(state.volume));
    return switched;
  };

  const disposeBoost = () => {
    boostGraph?.source.disconnect();
    boostGraph?.gain.disconnect();
    boostGraph = null;
  };

  const attemptPlay = () => {
    if (disposed) return Promise.resolve(false);
    if (playAttempt) return playAttempt;
    const attempt = (async () => {
      try {
        await element.play();
        if (disposed) return false;
        nativePlaybackBlocked = false;
        setOutputBlocked(output, false);
        return true;
      } catch {
        if (!disposed) {
          nativePlaybackBlocked = true;
          setOutputBlocked(output, !boostGraph);
        }
        return false;
      }
    })();
    playAttempt = attempt;
    void attempt.then(() => {
      if (playAttempt === attempt) playAttempt = null;
    });
    return attempt;
  };

  const activateBoost = async (expectedGeneration: number) => {
    // A new native sink may be denied long after voice join. Reuse the context
    // unlocked by that join; creating another context cannot grant activation.
    const context = nativePlaybackBlocked ? sharedContext : getContext();
    if (!context) return false;
    if (nativePlaybackBlocked && context.state !== "running") {
      disposeBoost();
      applyDirectState();
      setOutputBlocked(output, true);
      return false;
    }
    try {
      await context.resume();
      if (context.state !== "running" || disposed || generation !== expectedGeneration || !needsGraph()) {
        return false;
      }
      const routed = await applySharedAudioOutputToContext(context);
      if (disposed || generation !== expectedGeneration || !needsGraph()) return false;
      if (!routed) {
        disposeBoost();
        applyDirectState();
        setOutputBlocked(output, nativePlaybackBlocked);
        return false;
      }
      if (!boostGraph) {
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        boostGraph = { source, gain };
        source.connect(gain);
        gain.connect(context.destination);
      }
      applyBoostGain(context, boostGraph.gain.gain, state.volume);
      if (element.srcObject !== stream) element.srcObject = stream;
      element.volume = 1;
      element.muted = true;
      setOutputBlocked(output, false);
      return true;
    } catch {
      if (disposed || generation !== expectedGeneration) return false;
      disposeBoost();
      applyDirectState();
      setOutputBlocked(output, nativePlaybackBlocked);
      return false;
    }
  };

  const applyRememberedSink = async () => {
    try {
      await applySharedAudioOutputToMediaElement(element);
    } catch {
      if (selectedOutputDeviceId) {
        await applyAudioOutputDevice("", { mediaElements: [element] }).catch(() => undefined);
      }
    }
  };

  const retry = async () => {
    if (disposed || !sinkApplied) return false;
    resumeSharedContext();
    const played = await attemptPlay();
    if (disposed) return false;
    if (needsGraph()) {
      const routed = await activateBoost(generation);
      return played || routed;
    }
    disposeBoost();
    applyDirectState();
    return played;
  };

  const onPlaying = () => {
    hasPlayed = true;
  };

  const onPause = () => {
    if (disposed || !hasPlayed || !element.paused) return;
    hasPlayed = false;
    // The hidden output has no user-facing play control. If the browser pauses
    // it after playback began, try to restore it while its remote stream lives.
    void retry();
  };

  const onCanPlay = () => {
    // ontrack can arrive before the bot's transport delivers any audio. A
    // failed first play must not strand the mounted output until a rejoin.
    if (!disposed && element.paused) void retry();
  };

  const refreshBoost = (forceRebuild = false) => {
    if (disposed) return;
    generation += 1;
    const expectedGeneration = generation;
    if (!needsGraph() || sharedContext?.state !== "running") {
      disposeBoost();
      applyDirectState();
      setOutputBlocked(output, nativePlaybackBlocked);
      return;
    }
    if (boostGraph && !forceRebuild) {
      if (sharedContext) applyBoostGain(sharedContext, boostGraph.gain.gain, state.volume);
      if (element.srcObject !== stream) element.srcObject = stream;
      element.volume = 1;
      element.muted = true;
      setOutputBlocked(output, false);
      return;
    }
    disposeBoost();
    applyDirectState();
    void activateBoost(expectedGeneration);
  };

  const output: ManagedAudioOutput = {
    element,
    get nativePlaybackBlocked() {
      return nativePlaybackBlocked;
    },
    ready: Promise.resolve(),
    refreshBoost,
    setVolume(muted, volume) {
      if (disposed) return;
      state = { muted, volume };
      refreshBoost();
    },
    retry,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("canplay", onCanPlay);
      disposeBoost();
      managedOutputs.delete(output);
      setOutputBlocked(output, false);
      element.pause();
      element.srcObject = null;
      activeOutputs = Math.max(0, activeOutputs - 1);
      if (activeOutputs === 0 && !sharedContextHeld) releaseUnusedSharedAudioOutput();
    }
  };

  element.addEventListener("playing", onPlaying);
  element.addEventListener("pause", onPause);
  element.addEventListener("canplay", onCanPlay);
  applyDirectState();
  activeOutputs += 1;
  managedOutputs.add(output);
  attachResumeListeners();
  output.ready = (async () => {
    await applyRememberedSink();
    sinkApplied = true;
    const played = await attemptPlay();
    if (!disposed && needsGraph() && (played || nativePlaybackBlocked)) {
      await activateBoost(generation);
    }
  })();
  return output;
}

/** Only playback state; no stream ids, device labels, addresses or audio samples. */
export function voiceOutputDiagnostics() {
  return {
    contextState: sharedContext?.state ?? null,
    outputs: [...managedOutputs].map(({ element, nativePlaybackBlocked }) => ({
      paused: element.paused,
      muted: element.muted,
      volume: element.volume,
      readyState: element.readyState,
      errorCode: element.error?.code ?? null,
      nativePlaybackBlocked
    })),
    blockedCount: blockedOutputs.size
  };
}
