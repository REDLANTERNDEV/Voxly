import {
  createNoiseGateState,
  noiseGateHighPassFrequency,
  noiseGateHighPassQ,
  noiseGateOpenGain,
  noiseGateTargetGain,
  noiseGateTimeConstant,
  stepNoiseGate
} from "./noiseGate.js";
import { voiceActivitySampleMs } from "./voiceActivity.js";
import { volumeGain } from "./voiceVolume.js";

export interface MicrophoneInput {
  rawStream: MediaStream;
  voiceStream: MediaStream;
  monitorStream: MediaStream;
  setVolume(volume: number): void;
  /**
   * Takes effect on the next audio block. Suppression lives in this graph
   * precisely so the preference never has to reopen the capture device.
   */
  setNoiseSuppression(enabled: boolean): void;
  dispose(): void;
}

type AudioContextFactory = () => AudioContext;

export interface MicrophoneInputOptions {
  createContext?: AudioContextFactory;
  noiseSuppression?: boolean;
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

function createBrowserAudioContext() {
  const AudioContextClass = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error("audio_context_unavailable");
  return new AudioContextClass();
}

export function createMicrophoneInput(
  rawStream: MediaStream,
  initialVolume: number,
  options: MicrophoneInputOptions = {}
): MicrophoneInput {
  const createContext = options.createContext ?? createBrowserAudioContext;
  const schedule = options.setInterval ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const unschedule = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let highPass: BiquadFilterNode | null = null;
  let analyser: AnalyserNode | null = null;
  let gate: GainNode | null = null;
  let gain: GainNode | null = null;
  let voiceDestination: MediaStreamAudioDestinationNode | null = null;
  let monitorDestination: MediaStreamAudioDestinationNode | null = null;
  let noiseSuppression = options.noiseSuppression ?? true;
  try {
    context = createContext();
    source = context.createMediaStreamSource(rawStream);
    highPass = context.createBiquadFilter();
    analyser = context.createAnalyser();
    gate = context.createGain();
    gain = context.createGain();
    voiceDestination = context.createMediaStreamDestination();
    monitorDestination = context.createMediaStreamDestination();
    highPass.type = "highpass";
    highPass.Q.value = noiseGateHighPassQ;
    highPass.frequency.value = noiseGateHighPassFrequency(noiseSuppression);
    analyser.fftSize = 2048;
    gate.gain.value = noiseGateOpenGain;
    gain.gain.value = volumeGain(initialVolume);
    source.connect(highPass);
    // The expander measures the filtered signal, before its own gain, so its
    // reading never chases the reduction it just applied.
    highPass.connect(analyser);
    highPass.connect(gate);
    gate.connect(gain);
    gain.connect(voiceDestination);
    gain.connect(monitorDestination);
  } catch (cause) {
    source?.disconnect();
    highPass?.disconnect();
    analyser?.disconnect();
    gate?.disconnect();
    gain?.disconnect();
    for (const stream of [rawStream, voiceDestination?.stream, monitorDestination?.stream]) {
      stream?.getTracks().forEach((track) => track.stop());
    }
    void context?.close().catch(() => undefined);
    throw cause;
  }
  let disposed = false;

  const samples = new Float32Array(analyser.fftSize);
  let gateState = createNoiseGateState();
  let appliedGain = noiseGateOpenGain;

  const applyGateGain = (target: number, open: boolean) => {
    if (target === appliedGain) return;
    appliedGain = target;
    // Ramped rather than assigned: stepping a gain between blocks is a
    // discontinuity, and a discontinuity in a signal is a click.
    try {
      gate.gain.setTargetAtTime(target, context.currentTime, noiseGateTimeConstant(open));
    } catch {
      gate.gain.value = target;
    }
  };

  const timer = schedule(() => {
    if (disposed) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) {
      sum += value * value;
    }
    gateState = stepNoiseGate(gateState, Math.sqrt(sum / samples.length), Date.now());
    applyGateGain(noiseGateTargetGain(noiseSuppression, gateState.open), gateState.open);
  }, voiceActivitySampleMs);

  void context.resume().catch(() => undefined);

  return {
    rawStream,
    voiceStream: voiceDestination.stream,
    monitorStream: monitorDestination.stream,
    setVolume(volume) {
      if (!disposed) gain.gain.value = volumeGain(volume);
    },
    setNoiseSuppression(enabled) {
      if (disposed || noiseSuppression === enabled) return;
      noiseSuppression = enabled;
      try {
        highPass.frequency.setTargetAtTime(noiseGateHighPassFrequency(enabled), context.currentTime, 0.05);
      } catch {
        highPass.frequency.value = noiseGateHighPassFrequency(enabled);
      }
      applyGateGain(noiseGateTargetGain(enabled, gateState.open), gateState.open);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unschedule(timer);
      source.disconnect();
      highPass.disconnect();
      analyser.disconnect();
      gate.disconnect();
      gain.disconnect();
      for (const stream of [rawStream, voiceDestination.stream, monitorDestination.stream]) {
        stream.getTracks().forEach((track) => track.stop());
      }
      void context.close().catch(() => undefined);
    }
  };
}
