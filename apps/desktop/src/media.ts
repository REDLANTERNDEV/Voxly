export type ProbeKind = "microphone" | "camera" | "screen";

export interface ProbeTrack {
  kind: string;
  readyState: string;
  enabled: boolean;
  muted: boolean;
  settings: Record<string, string | number | boolean>;
}

export function summarizeTracks(stream: Pick<MediaStream, "getTracks">): ProbeTrack[] {
  const allowed = ["width", "height", "frameRate", "sampleRate", "channelCount", "echoCancellation", "noiseSuppression", "autoGainControl", "displaySurface"];
  return stream.getTracks().map((track) => {
    const raw = track.getSettings() as Record<string, unknown>;
    const settings: ProbeTrack["settings"] = {};
    for (const key of allowed) {
      const value = raw[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") settings[key] = value;
    }
    return { kind: track.kind, readyState: track.readyState, enabled: track.enabled, muted: track.muted, settings };
  });
}

/** Releases a capture that resolves after Stop, another probe, or disposal. */
export function createCaptureOwner() {
  let generation = 0;
  let current: MediaStream | null = null;
  const stop = () => {
    generation += 1;
    current?.getTracks().forEach((track) => track.stop());
    current = null;
  };
  return {
    stop,
    begin() { stop(); return generation; },
    accept(ticket: number, stream: MediaStream) {
      if (ticket !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      current = stream;
      return true;
    },
    current: () => current,
    isCurrent: (ticket: number) => ticket === generation
  };
}

export function probeConstraints(kind: Exclude<ProbeKind, "screen">): MediaStreamConstraints {
  return kind === "microphone"
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }
    : { audio: false, video: { width: { ideal: 640, max: 640 }, height: { ideal: 360, max: 360 }, frameRate: { ideal: 24, max: 24 } } };
}

export const screenConstraints: DisplayMediaStreamOptions = {
  video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } },
  audio: true
};
