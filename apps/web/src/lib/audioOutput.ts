import {
  applyAudioOutputDevice,
  supportsAudioOutputSelection,
  type AudioOutputApplication
} from "./audioDevices.js";
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

function refreshManagedBoosts() {
  for (const output of managedOutputs) output.refreshBoost();
}

function getContext() {
  if (sharedContext) return sharedContext;
  const AudioContextClass = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    sharedContext = new AudioContextClass();
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
  if (activeOutputs > 0 || !sharedContext) return false;
  const context = sharedContext;
  sharedContext = null;
  context.removeEventListener?.("statechange", refreshManagedBoosts);
  detachResumeListeners();
  void context.close().catch(() => undefined);
  return true;
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
  ready: Promise<void>;
  setVolume: (muted: boolean, volume: number) => void;
  retry: () => Promise<boolean>;
  dispose: () => void;
};

export function sharedAudioOutputSelectionSupported(mediaElements: readonly HTMLMediaElement[] = []) {
  if (typeof window === "undefined") return false;
  const fallbackElements = [window.HTMLMediaElement?.prototype]
    .filter((element): element is HTMLMediaElement => Boolean(element));
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
  outputSelectionQueue = outputSelectionQueue.catch(() => "unsupported").then(async () => {
    const elements = [...new Set([
      ...[...managedOutputs].map((output) => output.element),
      ...mediaElements
    ])];
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
  const results = await Promise.all([...blockedOutputs].map((output) => output.retry()));
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

  const attemptPlay = async () => {
    try {
      await element.play();
      setOutputBlocked(output, false);
      return { ok: true as const };
    } catch (cause) {
      setOutputBlocked(output, true);
      return { ok: false as const, cause };
    }
  };

  const activateBoost = async (expectedGeneration: number) => {
    const context = getContext();
    if (!context) return false;
    try {
      await context.resume();
      if (context.state !== "running" || disposed || generation !== expectedGeneration || state.muted || state.volume <= 100) {
        return false;
      }
      if (!await applySharedAudioOutputToContext(context)) {
        disposeBoost();
        applyDirectState();
        return false;
      }
      if (disposed || generation !== expectedGeneration || state.muted || state.volume <= 100) return false;
      if (!boostGraph) {
        const source = context.createMediaStreamSource(stream);
        const gain = context.createGain();
        source.connect(gain);
        gain.connect(context.destination);
        boostGraph = { source, gain };
      }
      applyBoostGain(context, boostGraph.gain.gain, state.volume);
      if (element.srcObject !== stream) element.srcObject = stream;
      element.volume = 1;
      element.muted = true;
      return true;
    } catch {
      disposeBoost();
      applyDirectState();
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
    if (disposed) return false;
    resumeSharedContext();
    const played = await attemptPlay();
    if (played.ok && !state.muted && state.volume > 100 && element.srcObject === stream) {
      await activateBoost(generation);
    }
    return played.ok;
  };

  const refreshBoost = (forceRebuild = false) => {
    if (disposed) return;
    generation += 1;
    const expectedGeneration = generation;
    if (state.muted || state.volume <= 100 || sharedContext?.state !== "running") {
      disposeBoost();
      applyDirectState();
      return;
    }
    if (boostGraph && !forceRebuild) {
      if (sharedContext) applyBoostGain(sharedContext, boostGraph.gain.gain, state.volume);
      if (element.srcObject !== stream) element.srcObject = stream;
      element.volume = 1;
      element.muted = true;
      return;
    }
    disposeBoost();
    applyDirectState();
    void activateBoost(expectedGeneration);
  };

  const output: ManagedAudioOutput = {
    element,
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
      disposeBoost();
      managedOutputs.delete(output);
      setOutputBlocked(output, false);
      element.pause();
      element.srcObject = null;
      activeOutputs = Math.max(0, activeOutputs - 1);
      if (activeOutputs === 0 && !sharedContextHeld) releaseUnusedSharedAudioOutput();
    }
  };

  applyDirectState();
  activeOutputs += 1;
  managedOutputs.add(output);
  attachResumeListeners();
  output.ready = (async () => {
    await applyRememberedSink();
    const played = await attemptPlay();
    if (played.ok && !state.muted && state.volume > 100) {
      await activateBoost(generation);
    }
  })();
  return output;
}
