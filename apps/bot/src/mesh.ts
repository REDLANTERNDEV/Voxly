/**
 * The bot's side of Voxly's voice mesh.
 *
 * The Music bot is a peer like any other — see
 * `docs/adr/0001-music-bot-is-a-mesh-peer.md` — so the rules that decide who
 * offers and who yields are imported from `@voxly/shared` rather than restated
 * here. Both halves of a pair have to reach the same answer from the same two
 * user ids; a private copy that drifted would leave one side waiting for an
 * offer the other was never going to send.
 *
 * The spike this grew out of deliberately broke that symmetry and offered to
 * everyone, because a Listener who joined with no microphone produced an offer
 * with no media sections at all. That defect is fixed in the client — it now
 * always offers a `recvonly` audio section — so the bot follows the shared rule
 * like everybody else.
 */

import {
  isRtcRecoveryRequest,
  shouldIgnoreIncomingOffer,
  shouldInitiatePeerConnection,
  type RtcSignal,
  type VoiceSignalingState,
  type VoiceSnapshot
} from "@voxly/shared";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCIceCandidateInit
} from "werift";
import type { IceServer } from "./voxly.js";

/**
 * The one codec the bot speaks. Opus at 48 kHz stereo with payload type 111 is
 * what browsers offer, and the bot never transcodes, so agreeing on it up front
 * is the whole negotiation as far as media formats go. A mono Track in a stereo
 * payload is not a mismatch: the decoder reads the channel count from the Opus
 * packet itself.
 */
const opusCodec = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48_000,
  channels: 2,
  payloadType: 111,
  parameters: "minptime=10;useinbandfec=1"
});

/**
 * The signal shapes on the wire. `RtcSignal` is deliberately opaque in the
 * shared contract — the server forwards it without reading it — so each peer
 * names the shape it actually sends.
 */
type PeerSignal =
  | { type: "offer"; sdp: string; streams?: StreamDescriptor[] }
  | { type: "answer"; sdp: string; streams?: StreamDescriptor[] }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "recovery-request" };

interface StreamDescriptor {
  id: string;
  kind: "audio" | "camera" | "screen";
}

/** The signalling the mesh needs, narrowed so tests can stand in for a socket. */
export interface MeshSignalling {
  emit: (payload: { roomId: string; toUserId: string; signal: RtcSignal }) => void;
  on: (handler: (payload: { roomId: string; fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => void) => void;
  off: (handler: (payload: { roomId: string; fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => void) => void;
}

export interface MeshOptions {
  signalling: MeshSignalling;
  roomId: string;
  selfUserId: string;
  iceServers: IceServer[];
  /** The audio this peer sends to `peerUserId`. One output per Listener. */
  createOutput: (peerUserId: string) => MediaStreamTrack;
  /**
   * This Listener's transport is up. Everything written before now went
   * nowhere, so whatever feeds `createOutput` may want to treat the next frame
   * as the start of the audio this Listener hears.
   */
  onListenerConnected?: (peerUserId: string) => void;
  onPeerRemoved?: (peerUserId: string) => void;
  log?: (message: string) => void;
}

interface Peer {
  userId: string;
  connection: RTCPeerConnection;
  streamId: string;
  pendingCandidates: RTCIceCandidateInit[];
  /** An offer has actually gone out, not merely been attempted. */
  offered: boolean;
  makingOffer: boolean;
  pendingOffer: boolean;
  ignoringOffer: boolean;
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recoveryGeneration: number;
}

/** A candidate queue for a peer that never answers must not grow without end. */
const maxPendingCandidates = 128;
const recoveryGraceMs = 3_000;
const recoveryTimeoutMs = 10_000;

export class VoiceMesh {
  private readonly mediaInstances = new Map<string, string>();
  private readonly peers = new Map<string, Peer>();
  private readonly log: (message: string) => void;
  private started = false;

  constructor(private readonly options: MeshOptions) {
    this.log = options.log ?? (() => undefined);
  }

  get listenerUserIds() {
    return [...this.peers.keys()];
  }

  /** Re-check only unhealthy listeners before playback resumes. */
  recoverUnhealthyPeers() {
    for (const peer of this.peers.values()) {
      if (peer.connection.connectionState === "disconnected" || peer.connection.connectionState === "failed") {
        this.recoverPeer(peer);
      }
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.options.signalling.on(this.onSignal);
  }

  async stop() {
    this.options.signalling.off(this.onSignal);
    this.started = false;
    await Promise.all([...this.peers.keys()].map((userId) => this.removePeer(userId)));
    this.mediaInstances.clear();
  }

  /**
   * Bring the mesh in line with who is in the room.
   *
   * Peers are created for everyone present, including the ones this side will
   * not offer to: their offer has to land on a connection that already carries
   * the bot's audio, or the answer would have nothing to send.
   */
  applySnapshot(snapshot: VoiceSnapshot) {
    if (snapshot.roomId !== this.options.roomId) return;
    const present = new Set(snapshot.members.map((member) => member.user.userId));
    present.delete(this.options.selfUserId);

    for (const userId of this.peers.keys()) {
      if (!present.has(userId)) void this.removePeer(userId);
    }
    for (const userId of this.mediaInstances.keys()) {
      if (!present.has(userId)) this.mediaInstances.delete(userId);
    }
    for (const member of snapshot.members) {
      const userId = member.user.userId;
      if (!present.has(userId)) continue;
      const instance = member.mediaInstanceId;
      const previous = this.mediaInstances.get(userId);
      if (instance && previous && instance !== previous) {
        // removePeer detaches synchronously before awaiting transport cleanup.
        void this.removePeer(userId);
      }
      if (instance) this.mediaInstances.set(userId, instance);
      this.ensureOffered(this.ensurePeer(userId));
    }
  }

  private readonly onSignal = (payload: { roomId: string; fromUserId: string; mediaInstanceId?: string; signal: RtcSignal }) => {
    if (!this.started || payload.roomId !== this.options.roomId) return;
    const instance = this.mediaInstances.get(payload.fromUserId);
    if (payload.mediaInstanceId && instance && payload.mediaInstanceId !== instance) return;
    if (payload.mediaInstanceId) this.mediaInstances.set(payload.fromUserId, payload.mediaInstanceId);
    void this.handleSignal(payload.fromUserId, payload.signal as PeerSignal).catch((cause: unknown) => {
      // Fire and forget on purpose: one peer's failed negotiation must not take
      // the process, or anybody else's audio, down with it.
      this.log(`signal from ${short(payload.fromUserId)} failed: ${String(cause)}`);
    });
  };

  private ensurePeer(userId: string) {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({
      codecs: { audio: [opusCodec] },
      iceServers: this.options.iceServers
    });

    const output = this.options.createOutput(userId);
    const streamId = `voxly-music-${this.options.selfUserId}`;
    const stream = new MediaStream({ id: streamId, tracks: [] });
    stream.addTrack(output);
    connection.addTrack(output, stream);

    const peer: Peer = {
      userId,
      connection,
      streamId,
      pendingCandidates: [],
      offered: false,
      makingOffer: false,
      pendingOffer: false,
      ignoringOffer: false,
      recoveryTimer: null,
      recoveryGeneration: 0
    };
    this.peers.set(userId, peer);

    connection.onIceCandidate.subscribe((candidate) => {
      if (!candidate || this.peers.get(userId) !== peer) return;
      this.emitSignal(userId, { type: "candidate", candidate: candidate.toJSON() });
    });
    connection.connectionStateChange.subscribe((state) => {
      if (this.peers.get(userId) !== peer) return;
      this.log(`listener ${short(userId)} ${state}`);
      if (state === "connected") {
        if (peer.recoveryTimer !== null) {
          clearTimeout(peer.recoveryTimer);
          peer.recoveryTimer = null;
        }
        this.options.onListenerConnected?.(userId);
        return;
      }
      if (state === "failed") {
        this.recoverPeer(peer);
        return;
      }
      if (state === "disconnected" && peer.recoveryTimer === null) {
        const generation = ++peer.recoveryGeneration;
        peer.recoveryTimer = setTimeout(() => {
          peer.recoveryTimer = null;
          if (this.peers.get(userId) !== peer || peer.recoveryGeneration !== generation) return;
          if (peer.connection.connectionState === "disconnected") this.recoverPeer(peer);
        }, recoveryGraceMs);
      }
    });

    return peer;
  }

  private async removePeer(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    if (peer.recoveryTimer !== null) clearTimeout(peer.recoveryTimer);
    this.options.onPeerRemoved?.(userId);
    await peer.connection.close().catch(() => undefined);
  }

  private recoverPeer(peer: Peer) {
    if (this.peers.get(peer.userId) !== peer) return;
    if (peer.recoveryTimer !== null) {
      clearTimeout(peer.recoveryTimer);
      peer.recoveryTimer = null;
    }
    peer.recoveryGeneration += 1;
    if (!shouldInitiatePeerConnection(this.options.selfUserId, peer.userId)) {
      this.emitSignal(peer.userId, { type: "recovery-request" });
      return;
    }
    try {
      peer.connection.restartIce();
      void this.sendOffer(peer).catch((cause: unknown) => {
        this.log(`recovery offer to ${short(peer.userId)} failed: ${String(cause)}`);
        this.rebuildPeer(peer);
      });
    } catch (cause: unknown) {
      this.log(`recovery for ${short(peer.userId)} failed: ${String(cause)}`);
      this.rebuildPeer(peer);
    }
    const generation = peer.recoveryGeneration;
    setTimeout(() => {
      if (this.peers.get(peer.userId) !== peer || peer.recoveryGeneration !== generation) return;
      if (peer.connection.connectionState !== "connected") this.rebuildPeer(peer);
    }, recoveryTimeoutMs);
  }

  private rebuildPeer(peer: Peer) {
    if (this.peers.get(peer.userId) !== peer) return;
    const instance = this.mediaInstances.get(peer.userId);
    void this.removePeer(peer.userId).then(() => {
      if (!this.started || this.peers.has(peer.userId) || this.mediaInstances.get(peer.userId) !== instance) return;
      const replacement = this.ensurePeer(peer.userId);
      this.ensureOffered(replacement);
      if (!shouldInitiatePeerConnection(this.options.selfUserId, peer.userId)) {
        this.emitSignal(peer.userId, { type: "recovery-request" });
      }
    });
  }

  /**
   * Offer to this Listener if the shared rule picks this side, and if an offer
   * has not already gone out.
   *
   * Keyed on having offered rather than on the peer being new, because the peer
   * is often created by an incoming signal that beat the snapshot through the
   * server. Skipping those would mean never offering to them — which is exactly
   * the silence the rule exists to prevent.
   */
  private ensureOffered(peer: Peer) {
    if (peer.offered || peer.makingOffer) return;
    if (!shouldInitiatePeerConnection(this.options.selfUserId, peer.userId)) return;
    void this.sendOffer(peer).catch((cause: unknown) => {
      this.log(`offer to ${short(peer.userId)} failed: ${String(cause)}`);
    });
  }

  private async sendOffer(peer: Peer) {
    if (peer.makingOffer || peer.connection.signalingState !== "stable") {
      peer.pendingOffer = true;
      return;
    }
    peer.makingOffer = true;
    try {
      const offer = await peer.connection.createOffer();
      // The Listener's own offer can land while this one is still being built,
      // which leaves the connection in have-remote-offer and makes applying a
      // local offer an InvalidStateError. Re-check rather than throw; whoever
      // handles that offer re-runs this one.
      if (this.peers.get(peer.userId) !== peer) return;
      if (peer.connection.signalingState !== "stable") {
        peer.pendingOffer = true;
        return;
      }
      await peer.connection.setLocalDescription(offer);
      const sdp = peer.connection.localDescription?.sdp;
      if (!sdp || this.peers.get(peer.userId) !== peer) return;
      peer.offered = true;
      this.emitSignal(peer.userId, { type: "offer", sdp, streams: streamDescriptors(peer) });
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleSignal(fromUserId: string, signal: PeerSignal) {
    const peer = this.ensurePeer(fromUserId);
    const { connection } = peer;

    if (isRtcRecoveryRequest(signal)) {
      if (!shouldInitiatePeerConnection(this.options.selfUserId, fromUserId)) return;
      this.recoverPeer(peer);
      return;
    }

    if (signal.type === "offer") {
      const signalingState = connection.signalingState as VoiceSignalingState;
      if (shouldIgnoreIncomingOffer(this.options.selfUserId, fromUserId, signalingState, peer.makingOffer)) {
        peer.ignoringOffer = true;
        peer.pendingCandidates = [];
        return;
      }
      // The polite side drops its own attempt rather than cancelling both.
      if (connection.signalingState !== "stable") {
        await connection.setLocalDescription({ type: "rollback" });
        if (this.peers.get(fromUserId) !== peer) return;
      }
      peer.ignoringOffer = false;
      await connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      if (this.peers.get(fromUserId) !== peer) return;
      await this.flushCandidates(peer);
      if (this.peers.get(fromUserId) !== peer) return;
      const answer = await connection.createAnswer();
      if (this.peers.get(fromUserId) !== peer) return;
      await connection.setLocalDescription(answer);
      if (this.peers.get(fromUserId) !== peer) return;
      const sdp = connection.localDescription?.sdp;
      if (sdp) this.emitSignal(fromUserId, { type: "answer", sdp, streams: streamDescriptors(peer) });
      // Answering settles the connection, so this side's own audio is already
      // on it; there is nothing left to offer. `offered` records that.
      peer.offered = true;
      await this.resumePendingOffer(peer);
      return;
    }

    if (signal.type === "answer") {
      peer.ignoringOffer = false;
      await connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      if (this.peers.get(fromUserId) !== peer) return;
      await this.flushCandidates(peer);
      if (this.peers.get(fromUserId) !== peer) return;
      await this.resumePendingOffer(peer);
      return;
    }

    if (peer.ignoringOffer) return;
    if (!connection.remoteDescription) {
      // A candidate can beat its offer through the server. Hold it rather than
      // rejecting it.
      if (peer.pendingCandidates.length < maxPendingCandidates) peer.pendingCandidates.push(signal.candidate);
      return;
    }
    await connection.addIceCandidate(signal.candidate).catch(() => undefined);
  }

  private async resumePendingOffer(peer: Peer) {
    if (this.peers.get(peer.userId) !== peer || !peer.pendingOffer) return;
    peer.pendingOffer = false;
    await this.sendOffer(peer);
  }

  private async flushCandidates(peer: Peer) {
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of candidates) {
      if (this.peers.get(peer.userId) !== peer) return;
      // One candidate left over from an ignored offer carries a stale ufrag and
      // is rejected. Keep going so it cannot block the valid ones behind it.
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private emitSignal(toUserId: string, signal: PeerSignal) {
    this.options.signalling.emit({
      roomId: this.options.roomId,
      toUserId,
      signal: signal as unknown as RtcSignal
    });
  }
}

/**
 * What the browser needs to file the incoming track under. The client reads
 * these to tell a microphone apart from a camera or a screen share; without one
 * the bot's audio would still arrive, but as an unlabelled stream.
 */
function streamDescriptors(peer: Peer): StreamDescriptor[] {
  return [{ id: peer.streamId, kind: "audio" }];
}

function short(userId: string) {
  return userId.slice(0, 8);
}
