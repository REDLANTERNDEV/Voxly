import type { VoiceMediaState } from "@voxly/shared";
import type { VoiceControls } from "./voiceControls.js";

export type MediaKind = "mic" | "camera" | "screen";

export type LocalVoiceMediaStreams = Partial<Record<MediaKind, MediaStream>>;

export function effectiveVoiceMediaState(
  controls: VoiceControls,
  streams: LocalVoiceMediaStreams
): VoiceMediaState {
  const mic = controls.mic.on
    && !controls.deafen.on
    && hasEnabledLiveTrack(streams.mic?.getAudioTracks());

  return {
    mic,
    camera: controls.camera.on && hasEnabledLiveTrack(streams.camera?.getVideoTracks()),
    screen: controls.screenShare.on && hasEnabledLiveTrack(streams.screen?.getVideoTracks()),
    deafened: controls.deafen.on,
    speaking: false
  };
}

export function watchMicrophoneStreamEnd(stream: MediaStream, onEnded: () => void) {
  const tracks = stream.getAudioTracks();
  let active = true;
  let reported = false;
  const handleEnded = () => {
    if (!active || reported || tracks.some((track) => track.readyState === "live")) return;
    reported = true;
    onEnded();
  };

  tracks.forEach((track) => track.addEventListener("ended", handleEnded));
  handleEnded();
  return () => {
    active = false;
    tracks.forEach((track) => track.removeEventListener("ended", handleEnded));
  };
}

function hasEnabledLiveTrack(tracks: MediaStreamTrack[] | undefined) {
  return tracks?.some((track) => track.enabled && track.readyState === "live") ?? false;
}

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
        frameRate: { ideal: 30, max: 30 }
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

export function configureScreenTrack(track: MediaStreamTrack) {
  if (track.kind === "video") track.contentHint = "detail";
}

export async function preferScreenSenderResolution(sender: RTCRtpSender, screenTrack: MediaStreamTrack) {
  if (screenTrack.kind !== "video" || sender.track !== screenTrack) return false;
  const parameters = sender.getParameters() as RTCRtpSendParameters & {
    degradationPreference?: "maintain-resolution";
  };
  parameters.degradationPreference = "maintain-resolution";
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

interface PeerWithTransceivers {
  getTransceivers(): ReadonlyArray<{ direction: RTCRtpTransceiverDirection; receiver: { track: { kind: string } } }>;
  addTransceiver(kind: "audio", init: { direction: "recvonly" }): unknown;
}

/**
 * Give an offer an audio section to carry when this member sends none.
 *
 * A member who joined with the microphone off has no audio track, so
 * `createOffer` writes no audio section — and with nothing else to publish, no
 * media sections at all. That connection can never carry anything: the answer
 * to it is not applicable, this side stays in `have-local-offer`, every later
 * offer collides with the stuck one, and recovery rebuilds the same empty
 * offer. Whether a pair hits it is a coin flip on how the two user ids sort,
 * which is why it has stayed invisible — the only room joined muted today is
 * AFK, where nobody has anything to send.
 *
 * The narrower case matters too: the same member publishing a camera offers a
 * video section and looks healthy, but an answerer cannot add an audio section
 * the offer left out, so nobody in that pair is ever heard.
 *
 * A `recvonly` section costs nothing once a microphone does arrive: `addTrack`
 * reuses an unused transceiver of the same kind and turns it into a sending one.
 */
export function ensureOfferableAudioSection(peer: PeerWithTransceivers) {
  const carriesAudio = peer.getTransceivers().some(
    (transceiver) => transceiver.receiver.track.kind === "audio" && transceiver.direction !== "stopped"
  );
  if (carriesAudio) return;
  peer.addTransceiver("audio", { direction: "recvonly" });
}

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
