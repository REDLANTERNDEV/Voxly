export type MediaKind = "mic" | "camera" | "screen";

export interface VoiceMediaUiState {
  joined: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  error: string;
}

export function createInitialMediaState(): VoiceMediaUiState {
  return {
    joined: false,
    mic: false,
    camera: false,
    screen: false,
    error: ""
  };
}

export function mediaConstraintsFor(kind: Exclude<MediaKind, "mic">): MediaStreamConstraints {
  if (kind === "screen") {
    return {
      video: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 15, max: 15 }
      },
      audio: true
    };
  }

  return {
    video: {
      width: { ideal: 640, max: 640 },
      height: { ideal: 360, max: 360 },
      frameRate: { ideal: 24, max: 24 }
    },
    audio: false
  };
}

export const micConstraints: MediaStreamConstraints = {
  audio: true,
  video: false
};

interface PeerWithSenders {
  getSenders(): Array<{ track: MediaStreamTrack | null; replaceTrack(track: MediaStreamTrack | null): Promise<void> }>;
}

export async function replaceMicrophoneTrack(
  peers: Iterable<PeerWithSenders>,
  previousTrack: MediaStreamTrack | undefined,
  nextTrack: MediaStreamTrack
) {
  if (!previousTrack) return 0;
  const matchingSenders = [...peers].flatMap((peer) => peer.getSenders().filter((sender) => sender.track === previousTrack));
  const results = await Promise.allSettled(matchingSenders.map((sender) => sender.replaceTrack(nextTrack)));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), "Microphone track replacement failed");
  }
  return matchingSenders.length;
}
