import { volumeGain } from "./voiceVolume.js";

export interface MicrophoneInput {
  rawStream: MediaStream;
  voiceStream: MediaStream;
  monitorStream: MediaStream;
  setVolume(volume: number): void;
  dispose(): void;
}

type AudioContextFactory = () => AudioContext;

function createBrowserAudioContext() {
  const AudioContextClass = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error("audio_context_unavailable");
  return new AudioContextClass();
}

export function createMicrophoneInput(
  rawStream: MediaStream,
  initialVolume: number,
  createContext: AudioContextFactory = createBrowserAudioContext
): MicrophoneInput {
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let voiceDestination: MediaStreamAudioDestinationNode | null = null;
  let monitorDestination: MediaStreamAudioDestinationNode | null = null;
  try {
    context = createContext();
    source = context.createMediaStreamSource(rawStream);
    gain = context.createGain();
    voiceDestination = context.createMediaStreamDestination();
    monitorDestination = context.createMediaStreamDestination();
    gain.gain.value = volumeGain(initialVolume);
    source.connect(gain);
    gain.connect(voiceDestination);
    gain.connect(monitorDestination);
  } catch (cause) {
    source?.disconnect();
    gain?.disconnect();
    for (const stream of [rawStream, voiceDestination?.stream, monitorDestination?.stream]) {
      stream?.getTracks().forEach((track) => track.stop());
    }
    void context?.close().catch(() => undefined);
    throw cause;
  }
  let disposed = false;

  void context.resume().catch(() => undefined);

  return {
    rawStream,
    voiceStream: voiceDestination.stream,
    monitorStream: monitorDestination.stream,
    setVolume(volume) {
      if (!disposed) gain.gain.value = volumeGain(volume);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      source.disconnect();
      gain.disconnect();
      for (const stream of [rawStream, voiceDestination.stream, monitorDestination.stream]) {
        stream.getTracks().forEach((track) => track.stop());
      }
      void context.close().catch(() => undefined);
    }
  };
}
