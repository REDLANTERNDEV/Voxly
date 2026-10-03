import type { RemoteMediaKind } from "./voiceStreams.js";

/** Owns transport lifetime. Signaling policy remains in the voice orchestrator. */
export class VoicePeerOwner {
  readonly peers = new Map<string, RTCPeerConnection>();
  readonly generations = new Map<string, number>();
  private readonly trackKinds = new WeakMap<RTCPeerConnection, Map<string, RemoteMediaKind>>();

  noteTrack(peer: RTCPeerConnection, track: MediaStreamTrack, kind: RemoteMediaKind) {
    const kinds = this.trackKinds.get(peer) ?? new Map();
    kinds.set(track.id, kind);
    this.trackKinds.set(peer, kinds);
  }

  microphoneTrackIds(peer: RTCPeerConnection) {
    const kinds = this.trackKinds.get(peer);
    return kinds ? [...kinds].filter(([, kind]) => kind === "audio").map(([id]) => id) : [];
  }

  activeAudioTrackIds(peer: RTCPeerConnection) {
    return peer.getTransceivers().filter(transceiver =>
      (transceiver.currentDirection === "sendrecv" || transceiver.currentDirection === "recvonly")
      && transceiver.receiver.track.kind === "audio" && transceiver.receiver.track.readyState === "live"
    ).map(transceiver => transceiver.receiver.track.id);
  }

  release(userId: string, expected?: RTCPeerConnection) {
    const peer = this.peers.get(userId);
    if (expected && expected !== peer) return false;
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    // Remove identity before close can dispatch an event from the old transport.
    this.peers.delete(userId);
    if (peer) {
      this.trackKinds.delete(peer);
      peer.close();
    }
    return Boolean(peer);
  }

  clear() {
    for (const userId of this.peers.keys()) this.release(userId);
    this.generations.clear();
  }
}
