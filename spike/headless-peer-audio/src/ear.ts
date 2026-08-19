import OpusScript from "opusscript";
import type { MediaStreamTrack } from "werift";

/**
 * What a headless Listener heard.
 *
 * Counting packets only proves that bytes moved. The point of this spike is
 * sound, so the ear decodes what arrives and measures it: a media path that
 * negotiates perfectly and delivers silence is the failure worth catching.
 */
export interface Hearing {
  userId: string;
  packets: number;
  bytes: number;
  /** Packets the sequence numbers say never arrived. */
  lost: number;
  /** Packets that arrived but libopus refused. Corruption, not loss. */
  undecodable: number;
  seconds: number;
  peakDbfs: number;
  rmsDbfs: number;
  firstHeardAt: number;
  lastHeardAt: number;
}

const silence = -Infinity;

export class Ear {
  private readonly decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  private readonly heard = new Map<string, Mutable>();
  private readonly subscriptions = new Map<string, () => void>();

  listenTo(userId: string, track: MediaStreamTrack) {
    if (track.kind !== "audio") return;
    const state = this.heard.get(userId) ?? newState(userId);
    this.heard.set(userId, state);
    // Renegotiation hands over a fresh track for the same Listener. Drop the
    // old subscription, or the same audio is counted twice.
    this.subscriptions.get(userId)?.();
    // The new track restarts the sequence numbering, so do not read a gap
    // across the handover.
    state.expectedSequence = undefined;

    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      const { sequenceNumber } = rtp.header;
      if (state.expectedSequence !== undefined) {
        const gap = (sequenceNumber - state.expectedSequence) & 0xffff;
        // A large gap is a reordered packet arriving late, not thousands lost.
        if (gap > 0 && gap < 1_000) state.lost += gap;
      }
      state.expectedSequence = (sequenceNumber + 1) & 0xffff;

      state.packets++;
      state.bytes += rtp.payload.length;
      state.firstHeardAt ||= Date.now();
      state.lastHeardAt = Date.now();

      try {
        const pcm = this.decoder.decode(rtp.payload);
        for (let at = 0; at + 1 < pcm.length; at += 2) {
          const sample = pcm.readInt16LE(at) / 32_768;
          state.sumSquares += sample * sample;
          state.peak = Math.max(state.peak, Math.abs(sample));
          state.samples++;
        }
      } catch {
        state.undecodable++;
      }
    });
    this.subscriptions.set(userId, unSubscribe);
  }

  forget(userId: string) {
    this.subscriptions.get(userId)?.();
    this.subscriptions.delete(userId);
    this.heard.delete(userId);
  }

  report(): Hearing[] {
    return [...this.heard.values()].map((state) => ({
      userId: state.userId,
      packets: state.packets,
      bytes: state.bytes,
      lost: state.lost,
      undecodable: state.undecodable,
      // Two channels out of the decoder, so samples are twice the frame count.
      seconds: state.samples / 2 / 48_000,
      peakDbfs: state.peak > 0 ? 20 * Math.log10(state.peak) : silence,
      rmsDbfs: state.samples > 0 && state.sumSquares > 0
        ? 20 * Math.log10(Math.sqrt(state.sumSquares / state.samples))
        : silence,
      firstHeardAt: state.firstHeardAt,
      lastHeardAt: state.lastHeardAt
    }));
  }

  close() {
    for (const unSubscribe of this.subscriptions.values()) unSubscribe();
    this.subscriptions.clear();
    this.decoder.delete();
  }
}

/** Audible in the sense that matters here: real signal, not a stream of zeroes. */
export function soundedLikeMusic(hearing: Hearing) {
  return hearing.packets > 0 && hearing.seconds > 0 && hearing.rmsDbfs > -50;
}

interface Mutable {
  userId: string;
  packets: number;
  bytes: number;
  lost: number;
  undecodable: number;
  samples: number;
  sumSquares: number;
  peak: number;
  expectedSequence?: number;
  firstHeardAt: number;
  lastHeardAt: number;
}

function newState(userId: string): Mutable {
  return {
    userId,
    packets: 0,
    bytes: 0,
    lost: 0,
    undecodable: 0,
    samples: 0,
    sumSquares: 0,
    peak: 0,
    firstHeardAt: 0,
    lastHeardAt: 0
  };
}

/** One line a person can scan: did it arrive, was it whole, was it loud enough. */
export function describeHearing(hearing: Hearing) {
  return [
    `from ${hearing.userId.slice(0, 8)}:`,
    `${hearing.packets} packets`,
    `${(hearing.bytes / 1024).toFixed(0)} KiB`,
    `${hearing.seconds.toFixed(1)}s decoded`,
    `${hearing.lost} lost`,
    `${hearing.undecodable} undecodable`,
    `peak ${hearing.peakDbfs.toFixed(1)} dBFS`,
    `rms ${hearing.rmsDbfs.toFixed(1)} dBFS`
  ].join("  ");
}
