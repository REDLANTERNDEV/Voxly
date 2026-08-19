import type { RtcSignal, VoiceSnapshot } from "@voxly/shared";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCIceCandidateInit
} from "werift";
import type { IceServer, VoxlySocket } from "./voxly.js";

/**
 * A headless participant in Voxly's voice mesh.
 *
 * The negotiation rules are deliberately the browser client's, copied from
 * `apps/web/src/lib/voiceNegotiation.ts` and `useVoiceMedia.ts`: the same
 * politeness tie-break, the same rollback on a colliding offer, the same
 * candidate queue, and the same `streams` descriptor alongside every offer and
 * answer. A bot that negotiated differently would prove nothing about whether
 * the real client can talk to it.
 */

export const opusCodec = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48_000,
  channels: 2,
  payloadType: 111,
  parameters: "minptime=10;useinbandfec=1"
});

type PeerSignal =
  | { type: "offer"; sdp: string; streams?: StreamDescriptor[] }
  | { type: "answer"; sdp: string; streams?: StreamDescriptor[] }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

interface StreamDescriptor {
  id: string;
  kind: "audio" | "camera" | "screen";
}

export interface MeshOptions {
  socket: VoxlySocket;
  roomId: string;
  selfUserId: string;
  iceServers: IceServer[];
  /** Refuse host and reflexive candidates, so every packet goes via TURN. */
  relayOnly?: boolean;
  /** The audio this peer sends to `peerUserId`, or nothing to only listen. */
  createOutput?: (peerUserId: string) => MediaStreamTrack | undefined;
  onRemoteTrack?: (peerUserId: string, track: MediaStreamTrack) => void;
  onPeerRemoved?: (peerUserId: string) => void;
  log?: (message: string) => void;
}

interface Peer {
  userId: string;
  connection: RTCPeerConnection;
  output?: MediaStreamTrack;
  streamId: string;
  pendingCandidates: RTCIceCandidateInit[];
  /** An offer has actually gone out, not merely been attempted. */
  offered: boolean;
  makingOffer: boolean;
  pendingOffer: boolean;
  ignoringOffer: boolean;
}

export class VoiceMesh {
  readonly peers = new Map<string, Peer>();
  private readonly log: (message: string) => void;
  private started = false;

  constructor(private readonly options: MeshOptions) {
    this.log = options.log ?? (() => undefined);
  }

  start() {
    if (this.started) return;
    this.started = true;
    const { socket, roomId } = this.options;
    socket.on("voice:snapshot", this.onSnapshot);
    socket.on("voice:left", this.onLeft);
    socket.on("rtc:signal", this.onSignal);
    this.log(`mesh watching room ${roomId}`);
  }

  async stop() {
    const { socket } = this.options;
    socket.off("voice:snapshot", this.onSnapshot);
    socket.off("voice:left", this.onLeft);
    socket.off("rtc:signal", this.onSignal);
    this.started = false;
    await Promise.all([...this.peers.keys()].map((userId) => this.removePeer(userId)));
  }

  applySnapshot(snapshot: VoiceSnapshot) {
    if (snapshot.roomId !== this.options.roomId) return;
    const present = new Set(snapshot.members.map((member) => member.user.userId));
    present.delete(this.options.selfUserId);

    for (const userId of this.peers.keys()) {
      if (!present.has(userId)) void this.removePeer(userId);
    }
    // Unlike the browser, this peer always offers rather than only when the
    // user-id tie-break says so. A Listener who joined with the microphone off
    // has no track to offer, so its offer carries no media section at all;
    // waiting for it would leave the room silent.
    for (const userId of present) this.ensureOffered(this.ensurePeer(userId));
  }

  private readonly onSnapshot = (snapshot: VoiceSnapshot) => {
    this.applySnapshot(snapshot);
  };

  private readonly onLeft = (payload: { roomId: string; userId: string }) => {
    if (payload.roomId !== this.options.roomId) return;
    void this.removePeer(payload.userId);
  };

  private readonly onSignal = (payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => {
    if (payload.roomId !== this.options.roomId) return;
    this.trace(`<- ${describeSignal(payload.signal as PeerSignal)} from ${short(payload.fromUserId)}`);
    void this.handleSignal(payload.fromUserId, payload.signal as PeerSignal).catch((error: unknown) => {
      this.log(`signal from ${short(payload.fromUserId)} failed: ${String(error)}`);
    });
  };

  private ensurePeer(userId: string) {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({
      codecs: { audio: [opusCodec] },
      iceServers: this.options.iceServers,
      iceTransportPolicy: this.options.relayOnly ? "relay" : "all"
    });

    const output = this.options.createOutput?.(userId);
    const streamId = `spike-music-${this.options.selfUserId}`;
    if (output) {
      const stream = new MediaStream({ id: streamId, tracks: [] });
      stream.addTrack(output);
      connection.addTrack(output, stream);
    }

    const peer: Peer = {
      userId,
      connection,
      output,
      streamId,
      pendingCandidates: [],
      offered: false,
      makingOffer: false,
      pendingOffer: false,
      ignoringOffer: false
    };
    this.peers.set(userId, peer);

    connection.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      this.emitSignal(userId, { type: "candidate", candidate: candidate.toJSON() });
    });
    connection.onTrack.subscribe((track) => {
      this.log(`track from ${short(userId)}: ${track.kind} ${track.codec?.mimeType ?? "?"}`);
      this.options.onRemoteTrack?.(userId, track);
    });
    connection.connectionStateChange.subscribe((state) => {
      this.log(`peer ${short(userId)} ${state}`);
    });

    this.log(`peer ${short(userId)} created${output ? " with music" : ""}`);
    return peer;
  }

  private async removePeer(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    this.options.onPeerRemoved?.(userId);
    await peer.connection.close().catch(() => undefined);
    this.log(`peer ${short(userId)} removed`);
  }

  /**
   * Offer to this peer unless we already have.
   *
   * Keyed on having offered rather than on the peer being new, because the peer
   * is often created by an incoming signal that beat the snapshot through the
   * server. Skipping those would mean never offering to them — which is exactly
   * the silence this always-offer rule exists to prevent.
   */
  private ensureOffered(peer: Peer) {
    if (peer.offered || !peer.output) return;
    this.offer(peer);
  }

  /** Fire and forget, so one failed negotiation cannot take the process down. */
  private offer(peer: Peer) {
    void this.sendOffer(peer).catch((error: unknown) => {
      this.log(`offer to ${short(peer.userId)} failed: ${String(error)}`);
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
      // The peer's offer can land while this one is still being built, which
      // leaves the connection in have-remote-offer and makes applying a local
      // offer an InvalidStateError. Re-check rather than throw; whoever handles
      // that offer will re-run this one.
      if (this.peers.get(peer.userId) !== peer) return;
      if (peer.connection.signalingState !== "stable") {
        peer.pendingOffer = true;
        return;
      }
      await peer.connection.setLocalDescription(offer);
      const sdp = peer.connection.localDescription?.sdp;
      if (!sdp || this.peers.get(peer.userId) !== peer) return;
      peer.offered = true;
      this.emitSignal(peer.userId, { type: "offer", sdp, streams: this.streamDescriptors(peer) });
    } finally {
      peer.makingOffer = false;
    }
  }

  private async handleSignal(fromUserId: string, signal: PeerSignal) {
    const peer = this.ensurePeer(fromUserId);
    const { connection } = peer;

    if (signal.type === "offer") {
      const collision = peer.makingOffer || connection.signalingState !== "stable";
      // The peer with the greater user id yields. Same rule, same direction, as
      // `shouldIgnoreIncomingOffer` in the web client.
      const polite = this.options.selfUserId > fromUserId;
      if (collision && !polite) {
        peer.ignoringOffer = true;
        peer.pendingCandidates = [];
        this.log(`ignored a colliding offer from ${short(fromUserId)}`);
        return;
      }
      if (collision && connection.signalingState !== "stable") {
        await connection.setLocalDescription({ type: "rollback" });
      }
      peer.ignoringOffer = false;
      await connection.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushCandidates(peer);
      await connection.setLocalDescription(await connection.createAnswer());
      const sdp = connection.localDescription?.sdp;
      if (sdp) {
        this.emitSignal(fromUserId, { type: "answer", sdp, streams: this.streamDescriptors(peer) });
      }
      if (peer.pendingOffer) {
        peer.pendingOffer = false;
        await this.sendOffer(peer);
      }
      this.ensureOffered(peer);
      return;
    }

    if (signal.type === "answer") {
      peer.ignoringOffer = false;
      await connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushCandidates(peer);
      if (peer.pendingOffer) {
        peer.pendingOffer = false;
        await this.sendOffer(peer);
      }
      this.ensureOffered(peer);
      return;
    }

    if (peer.ignoringOffer) return;
    if (!connection.remoteDescription) {
      // A candidate can beat its offer through the server. Hold it rather than
      // rejecting it, but do not let a broken peer grow the queue without end.
      if (peer.pendingCandidates.length < 128) peer.pendingCandidates.push(signal.candidate);
      return;
    }
    await connection.addIceCandidate(signal.candidate).catch(() => undefined);
  }

  private async flushCandidates(peer: Peer) {
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of candidates) {
      // One candidate left over from an ignored offer carries a stale ufrag and
      // is rejected. Keep going so it cannot block the valid ones behind it.
      await peer.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private streamDescriptors(peer: Peer): StreamDescriptor[] {
    return peer.output ? [{ id: peer.streamId, kind: "audio" }] : [];
  }

  private emitSignal(toUserId: string, signal: PeerSignal) {
    this.trace(`-> ${describeSignal(signal)} to ${short(toUserId)}`);
    this.options.socket.emit("rtc:signal", {
      roomId: this.options.roomId,
      toUserId,
      signal: signal as unknown as RtcSignal
    });
  }

  /** Set VOXLY_TRACE=1 to watch the negotiation packet by packet. */
  private trace(message: string) {
    if (process.env.VOXLY_TRACE === "1") this.log(message);
  }
}

function describeSignal(signal: PeerSignal) {
  if (signal.type === "candidate") return `candidate ${signal.candidate.candidate?.split(" ").slice(4, 8).join(" ") ?? ""}`;
  const sections = signal.sdp.split("\nm=").length - 1;
  const directions = [...signal.sdp.matchAll(/^a=(sendrecv|sendonly|recvonly|inactive)/gm)].map((match) => match[1]);
  return `${signal.type} ${sections} m-line(s) [${directions.join(",")}]`;
}

function short(userId: string) {
  return userId.slice(0, 8);
}
