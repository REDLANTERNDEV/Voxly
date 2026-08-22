/**
 * Encoded audio in, RTP frames out.
 *
 * Nothing here decodes or encodes anything: the bot reads Opus packets that are
 * already Opus and puts RTP headers on them. That is the property the whole
 * architecture rests on — see `docs/adr/0002-werift-for-the-bot-webrtc-stack.md` —
 * and it is why this module deals in packets rather than in samples.
 *
 * The Ogg reader is hand-rolled rather than taken from a library because it is
 * the shape the extractor path needs anyway: ffmpeg hands over encoded Opus and
 * this packetises it. werift's own file player accepts only MP4 and WebM.
 */

import { fileURLToPath } from "node:url";
import { RtpHeader, RtpPacket } from "werift";

/** 20 ms at 48 kHz: the frame size the bundled Track was encoded with. */
export const opusFrameSamples = 960;
export const opusFrameMs = opusFrameSamples / 48;

/**
 * The Track that ships with the bot. Synthesised rather than licensed, and
 * resolved from this module so it is found the same way from `dist` and from a
 * test.
 */
export const bundledTrackPath = fileURLToPath(new URL("../../assets/chime.opus", import.meta.url));

export interface OggOpusFile {
  channels: number;
  /** Samples libopus needs to discard at the start; reported, not applied. */
  preSkip: number;
  /** One Opus packet per entry, header packets removed. */
  packets: Buffer[];
}

export function readOggOpus(file: Buffer): OggOpusFile {
  const packets: Buffer[] = [];
  let carried: Buffer[] = [];
  let at = 0;

  while (at < file.length) {
    if (file.toString("ascii", at, at + 4) !== "OggS") {
      throw new Error(`Expected an OggS page at byte ${at}`);
    }
    const segmentCount = file.readUInt8(at + 26);
    const table = file.subarray(at + 27, at + 27 + segmentCount);
    let body = at + 27 + segmentCount;

    for (const size of table) {
      carried.push(file.subarray(body, body + size));
      body += size;
      // A lacing value below 255 terminates a packet. A run of 255s means the
      // packet continues, possibly onto the next page.
      if (size < 255) {
        packets.push(Buffer.concat(carried));
        carried = [];
      }
    }
    at = body;
  }

  const head = packets[0];
  if (!head || head.subarray(0, 8).toString("ascii") !== "OpusHead") {
    throw new Error("Expected the first packet to be an OpusHead identification header");
  }

  return {
    channels: head.readUInt8(9),
    preSkip: head.readUInt16LE(10),
    packets: packets.filter((packet) => {
      const magic = packet.subarray(0, 8).toString("ascii");
      return magic !== "OpusHead" && magic !== "OpusTags";
    })
  };
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

/** The `index`th frame of playback, looping the Track when it runs out. */
export function rtpFrameAt(packets: Buffer[], index: number, origin: RtpOrigin): RtpFrame {
  return {
    sequenceNumber: (origin.sequenceNumber + index) & 0xffff,
    timestamp: (origin.timestamp + index * opusFrameSamples) >>> 0,
    marker: index === 0,
    payload: packets[index % packets.length]!
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
