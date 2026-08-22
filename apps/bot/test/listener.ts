/**
 * A stand-in Listener for the mesh tests, and the relay that carries signals
 * between it and the bot.
 *
 * It is deliberately not the bot's own mesh pointed the other way. What these
 * tests need to know is whether the *browser client's* behaviour and the bot's
 * meet in the middle, so this reproduces the client's side of the contract:
 * the shared tie-break decides whether it offers, and a Listener with no
 * microphone still offers a `recvonly` audio section, exactly as
 * `ensureOfferableAudioSection` makes the real client do.
 */

import { shouldInitiatePeerConnection, type RtcSignal } from "@voxly/shared";
import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RtpPacket
} from "werift";
import type { MeshSignalling } from "../src/mesh.js";

const opusCodec = new RTCRtpCodecParameters({
  mimeType: "audio/opus",
  clockRate: 48_000,
  channels: 2,
  payloadType: 111,
  parameters: "minptime=10;useinbandfec=1"
});

type SignalHandler = (payload: { roomId: string; fromUserId: string; signal: RtcSignal }) => void;

/**
 * Delivers a signal from one user id to another, in this process. The server's
 * only job in a real room is this same relay, minus the authorization it has
 * already done by the time a signal is forwarded.
 */
export class SignalRelay {
  private readonly handlers = new Map<string, Set<SignalHandler>>();

  constructor(private readonly roomId: string) {}

  endpointFor(userId: string): MeshSignalling {
    return {
      emit: (payload) => {
        for (const handler of this.handlers.get(payload.toUserId) ?? []) {
          // Asynchronously, like a real hop through the server: a synchronous
          // relay hides every ordering bug these tests exist to catch.
          setImmediate(() => handler({ roomId: payload.roomId, fromUserId: userId, signal: payload.signal }));
        }
      },
      on: (handler) => {
        const existing = this.handlers.get(userId) ?? new Set<SignalHandler>();
        existing.add(handler);
        this.handlers.set(userId, existing);
      },
      off: (handler) => {
        this.handlers.get(userId)?.delete(handler);
      }
    };
  }

  get room() {
    return this.roomId;
  }
}

export interface FakeListenerOptions {
  relay: SignalRelay;
  userId: string;
  peerUserId: string;
  /** A Listener who joined with the microphone on also has audio to send. */
  microphone?: boolean;
}

export class FakeListener {
  readonly connection: RTCPeerConnection;
  readonly received: RtpPacket[] = [];
  private readonly signalling: MeshSignalling;
  private remoteDescriptionSet = false;
  private readonly pendingCandidates: Array<Record<string, unknown>> = [];

  constructor(private readonly options: FakeListenerOptions) {
    this.connection = new RTCPeerConnection({ codecs: { audio: [opusCodec] } });
    this.signalling = options.relay.endpointFor(options.userId);

    if (options.microphone) {
      const track = new MediaStreamTrack({ kind: "audio" });
      const stream = new MediaStream({ id: `listener-${options.userId}`, tracks: [] });
      stream.addTrack(track);
      this.connection.addTrack(track, stream);
    } else {
      // What `ensureOfferableAudioSection` gives a mic-less member: a media
      // section to carry, so the offer is answerable at all.
      this.connection.addTransceiver("audio", { direction: "recvonly" });
    }

    this.connection.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((packet) => this.received.push(packet));
    });
    this.connection.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      this.signalling.emit({
        roomId: options.relay.room,
        toUserId: options.peerUserId,
        signal: { type: "candidate", candidate: candidate.toJSON() } as unknown as RtcSignal
      });
    });
    this.signalling.on(this.onSignal);
  }

  /** Offers if the shared rule picks this side, exactly as the client does. */
  async announce() {
    if (!shouldInitiatePeerConnection(this.options.userId, this.options.peerUserId)) return;
    await this.connection.setLocalDescription(await this.connection.createOffer());
    this.send({ type: "offer", sdp: this.connection.localDescription?.sdp ?? "" });
  }

  async close() {
    this.signalling.off(this.onSignal);
    await this.connection.close().catch(() => undefined);
  }

  private readonly onSignal = (payload: { fromUserId: string; signal: RtcSignal }) => {
    void this.handle(payload.signal as { type: string; sdp?: string; candidate?: Record<string, unknown> })
      .catch(() => undefined);
  };

  private async handle(signal: { type: string; sdp?: string; candidate?: Record<string, unknown> }) {
    if (signal.type === "offer") {
      await this.connection.setRemoteDescription({ type: "offer", sdp: signal.sdp ?? "" });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      await this.connection.setLocalDescription(await this.connection.createAnswer());
      this.send({ type: "answer", sdp: this.connection.localDescription?.sdp ?? "" });
      return;
    }
    if (signal.type === "answer") {
      await this.connection.setRemoteDescription({ type: "answer", sdp: signal.sdp ?? "" });
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
      return;
    }
    if (!signal.candidate) return;
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(signal.candidate);
      return;
    }
    await this.connection.addIceCandidate(signal.candidate).catch(() => undefined);
  }

  private async flushCandidates() {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift();
      if (candidate) await this.connection.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private send(signal: { type: string; sdp: string }) {
    this.signalling.emit({
      roomId: this.options.relay.room,
      toUserId: this.options.peerUserId,
      signal: signal as unknown as RtcSignal
    });
  }
}

export function until(condition: () => boolean, what: string, timeoutMs = 15_000) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${what}`));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}
