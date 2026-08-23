/**
 * Encoded audio in, RTP frames out.
 *
 * Nothing here decodes or encodes anything: the bot reads Opus packets that are
 * already Opus and puts RTP headers on them. That is the property the whole
 * architecture rests on — see `docs/adr/0002-werift-for-the-bot-webrtc-stack.md` —
 * and it is why this module deals in packets rather than in samples.
 *
 * The Ogg reader is hand-rolled rather than taken from a library because
 * werift's own file player accepts only MP4 and WebM. It reads incrementally
 * because a fetched Track arrives over seconds rather than all at once, and
 * because the encoder is asked for Ogg Opus (ADR-0004) precisely so that a
 * fetched Track and a file on disk take the same path through here. A second
 * framing path is a second place for lacing to be got subtly wrong, and the
 * symptom of that is noise that sounds like a broken library.
 */

import { RtpHeader, RtpPacket } from "werift";

/** 20 ms at 48 kHz: the frame size everything here assumes. */
export const opusFrameSamples = 960;
export const opusFrameMs = opusFrameSamples / 48;

/** The fixed length of an Ogg page header before its lacing table. */
const oggHeaderBytes = 27;

/**
 * An Ogg Opus stream arriving in pieces.
 *
 * Fed whatever the encoder happened to write, it hands back the Opus packets
 * that are now complete and keeps the rest. Two kinds of incompleteness matter
 * and they are different: a page that has not finished arriving, which is held
 * in `pending` until it has, and a packet laced across a page boundary, which
 * is held in `carried` until its final segment turns up. Getting the second one
 * wrong is the classic Ogg mistake — it yields fragments that are individually
 * plausible and collectively noise.
 */
export class OggOpusReader {
  private pending: Buffer = Buffer.alloc(0);
  private carried: Buffer[] = [];
  private head: Buffer | null = null;

  /** Whatever became complete because of this chunk. Often nothing. */
  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const packets: Buffer[] = [];

    for (;;) {
      const page = this.takePage();
      if (!page) break;
      for (const packet of page) {
        const magic = packet.subarray(0, 8).toString("ascii");
        if (magic === "OpusHead") {
          this.head ??= packet;
          continue;
        }
        if (magic === "OpusTags") continue;
        packets.push(packet);
      }
    }
    return packets;
  }

  /** The identification header, once a page carrying it has arrived. */
  get identification(): { channels: number; preSkip: number } | null {
    const head = this.head;
    return head && head.length >= 12 ? { channels: head.readUInt8(9), preSkip: head.readUInt16LE(10) } : null;
  }

  /**
   * Whether anything is still held back. A stream that ends here has been
   * truncated mid-page or mid-packet, which is worth saying rather than
   * treating as a clean end.
   */
  get incomplete() {
    return this.pending.length > 0 || this.carried.length > 0;
  }

  /**
   * Consumes one whole page from `pending`, returning the packets it completed,
   * or `null` when there is not yet a whole page there to consume.
   */
  private takePage(): Buffer[] | null {
    // The magic is checked as soon as there is enough to check it. Waiting for
    // a whole header would let a stream of something else accumulate first, and
    // the report would then name the wrong problem.
    if (this.pending.length < 4) return null;
    if (this.pending.toString("ascii", 0, 4) !== "OggS") {
      throw new Error("Expected an OggS page");
    }
    if (this.pending.length < oggHeaderBytes) return null;
    const segmentCount = this.pending.readUInt8(26);
    const tableEnd = oggHeaderBytes + segmentCount;
    if (this.pending.length < tableEnd) return null;

    const table = this.pending.subarray(oggHeaderBytes, tableEnd);
    let bodyBytes = 0;
    for (const size of table) bodyBytes += size;
    if (this.pending.length < tableEnd + bodyBytes) return null;

    const packets: Buffer[] = [];
    let at = tableEnd;
    for (const size of table) {
      this.carried.push(this.pending.subarray(at, at + size));
      at += size;
      // A lacing value below 255 terminates a packet. A run of 255s means the
      // packet continues, possibly onto the next page.
      if (size < 255) {
        packets.push(Buffer.concat(this.carried));
        this.carried = [];
      }
    }
    this.pending = this.pending.subarray(at);
    return packets;
  }
}

/**
 * How much audio to have in hand before the first note.
 *
 * Two seconds. The extractor runs many times faster than realtime once it is
 * running, so what this actually buys is cover for the pause between its first
 * byte and its steady state — and it is short enough that a member who pasted a
 * link does not notice it on top of the fetch they are already waiting through.
 * Raising it trades time-to-first-note for fewer stalls on a slow line.
 */
export const prebufferFrames = 100;

/**
 * Encoded audio accumulating: what the fetch fills and the player reads.
 *
 * It lives here rather than beside the player because both ends of the pipe
 * need it and neither owns it — the fetch would otherwise have to reach into
 * playback for the shape of its own output.
 *
 * `complete` is the difference between "the next frame has not arrived yet" and
 * "there are no more frames", which are the same absence and want opposite
 * responses: wait, or finish.
 */
export class TrackBuffer {
  private readonly packets: Buffer[] = [];
  private done = false;

  /** A Track that is already whole — a file on disk, or a test fixture. */
  static of(packets: Buffer[]) {
    const buffer = new TrackBuffer();
    buffer.append(packets);
    buffer.finish();
    return buffer;
  }

  append(packets: Buffer[]) {
    for (const packet of packets) this.packets.push(packet);
  }

  /** No more audio is coming. Whatever is here is the whole Track. */
  finish() {
    this.done = true;
  }

  packetAt(index: number): Buffer | undefined {
    return this.packets[index];
  }

  get length() {
    return this.packets.length;
  }

  get complete() {
    return this.done;
  }

  /** Whether there is enough in hand to start without stalling immediately. */
  get readyToStart() {
    return this.done || this.packets.length >= prebufferFrames;
  }
}

/**
 * How many frames playback owes by `elapsedMs`.
 *
 * Pacing catches up against a clock rather than trusting a 20 ms interval,
 * which drifts. The player ticks faster than the frame rate and sends whatever
 * this says is due.
 */
export function framesDueBy(elapsedMs: number) {
  return Math.max(0, Math.floor(elapsedMs / opusFrameMs));
}

export interface RtpFrame {
  sequenceNumber: number;
  timestamp: number;
  marker: boolean;
  payload: Buffer;
}

export interface RtpOrigin {
  sequenceNumber: number;
  timestamp: number;
}

/** RFC 3550: a stream's first sequence number and timestamp are both random. */
export function randomRtpOrigin(): RtpOrigin {
  return {
    sequenceNumber: Math.floor(Math.random() * 0xffff),
    timestamp: Math.floor(Math.random() * 0xffff_ffff) >>> 0
  };
}

/**
 * The `index`th frame of playback, carrying an Opus packet the caller already
 * has. Nothing here loops: a Track ends, and what happens then belongs to
 * whatever owns the Queue rather than to the arithmetic.
 */
export function rtpFrameAt(payload: Buffer, index: number, origin: RtpOrigin): RtpFrame {
  return {
    sequenceNumber: (origin.sequenceNumber + index) & 0xffff,
    timestamp: (origin.timestamp + index * opusFrameSamples) >>> 0,
    marker: index === 0,
    payload
  };
}

/**
 * One packet object per Listener.
 *
 * werift's `RTCRtpSender.sendRtp` rewrites ssrc, payload type, sequence number
 * and timestamp on the object it is handed, and keeps that same object in its
 * retransmission cache. Handing one object to several senders leaves each cache
 * holding another Listener's header, so each Listener gets its own object built
 * from the shared payload. The encode still happens once; this costs an
 * allocation.
 */
export function toRtpPacket(frame: RtpFrame) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: frame.sequenceNumber,
      timestamp: frame.timestamp,
      marker: frame.marker,
      ssrc: 0
    }),
    frame.payload
  );
}
