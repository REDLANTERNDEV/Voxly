import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  OggOpusReader,
  framesDueBy,
  opusFrameMs,
  opusFrameSamples,
  rtpFrameAt,
  toRtpPacket
} from "../src/audio.js";
import { readOggOpus } from "./ogg.js";

/**
 * A real Ogg Opus file to read. It used to be the Track the bot played; it
 * retired to a fixture when the bot learned to fetch one (ADR-0004), and it is
 * kept because a hand-built page is not evidence that a real encoder's output
 * parses.
 */
const chimePath = fileURLToPath(new URL("../../test/assets/chime.opus", import.meta.url));

describe("readOggOpus", () => {
  it("reads a real file's header and audio packets", () => {
    const file = readOggOpus(readFileSync(chimePath));

    assert.equal(file.channels, 1);
    assert.equal(file.preSkip, 312);
    assert.ok(file.packets.length > 100, `expected a few seconds of audio, got ${file.packets.length} packets`);
    assert.ok(file.packets.every((packet) => packet.length > 0));
  });

  it("drops the two header packets rather than sending them as audio", () => {
    const file = readOggOpus(readFileSync(chimePath));

    assert.ok(!file.packets.some((packet) => packet.subarray(0, 8).toString("ascii") === "OpusHead"));
    assert.ok(!file.packets.some((packet) => packet.subarray(0, 8).toString("ascii") === "OpusTags"));
  });

  it("reassembles a packet that spans several lacing segments", () => {
    // A 600-byte packet laces as 255, 255, 90. A reader that treats every
    // segment as a packet would send three fragments and produce noise that is
    // easy to misdiagnose as the library not working.
    const audio = Buffer.alloc(600, 0xab);
    const file = readOggOpus(oggFile([opusHead(2, 156), opusTags(), audio]));

    assert.equal(file.channels, 2);
    assert.equal(file.preSkip, 156);
    assert.deepEqual(file.packets, [audio]);
  });

  it("keeps a packet that continues onto the next page in one piece", () => {
    const audio = Buffer.alloc(300, 0xcd);
    const file = readOggOpus(
      Buffer.concat([
        page(2, 0, 0, opusHead(1, 312)),
        page(0, 0, 1, opusTags()),
        page(0, 0, 2, audio.subarray(0, 255), [255]),
        page(1, 960, 3, audio.subarray(255), [45])
      ])
    );

    assert.deepEqual(file.packets, [audio]);
  });

  it("refuses a file that is not Ogg", () => {
    assert.throws(() => readOggOpus(Buffer.from("not an ogg file at all")), /OggS/);
  });

  it("refuses an Ogg file whose first packet is not an Opus header", () => {
    assert.throws(() => readOggOpus(oggFile([Buffer.from("VorbisXX"), opusTags()])), /OpusHead/);
  });
});

describe("reading an Ogg Opus stream as it arrives", () => {
  it("hands back nothing until a whole page is there, then the packets in it", () => {
    const audio = [Buffer.alloc(80, 1), Buffer.alloc(90, 2)];
    const stream = Buffer.concat([
      page(2, 0, 0, opusHead(2, 312)),
      page(0, 0, 1, opusTags()),
      page(0, 960, 2, Buffer.concat(audio), [80, 90])
    ]);
    const reader = new OggOpusReader();

    // Split mid-header, mid-lacing-table and mid-body, which is the shape a
    // pipe actually delivers: chunk boundaries have nothing to do with pages.
    assert.deepEqual(reader.push(stream.subarray(0, 10)), []);
    assert.equal(reader.identification, null, "the header has not arrived yet");
    assert.deepEqual(reader.push(stream.subarray(10, 40)), []);
    assert.deepEqual(reader.push(stream.subarray(40, stream.length - 60)), []);
    assert.deepEqual(reader.push(stream.subarray(stream.length - 60)), audio);
    assert.deepEqual(reader.identification, { channels: 2, preSkip: 312 });
    assert.equal(reader.incomplete, false);
  });

  it("holds a packet laced across a page boundary until its last segment lands", () => {
    // The classic Ogg mistake, and the one worth a test: releasing the 255-byte
    // fragment on its own yields audio that is individually plausible and
    // collectively noise.
    const audio = Buffer.alloc(300, 0xcd);
    const reader = new OggOpusReader();

    reader.push(Buffer.concat([page(2, 0, 0, opusHead(1, 312)), page(0, 0, 1, opusTags())]));
    assert.deepEqual(reader.push(page(0, 0, 2, audio.subarray(0, 255), [255])), []);
    assert.equal(reader.incomplete, true, "half a packet is not a packet");
    assert.deepEqual(reader.push(page(1, 960, 3, audio.subarray(255), [45])), [audio]);
    assert.equal(reader.incomplete, false);
  });

  it("reports a stream that stopped mid-page rather than calling it finished", () => {
    // A truncated fetch and a clean end look identical from the outside. They
    // are not, and the log is the only place the difference can show up.
    const reader = new OggOpusReader();
    reader.push(page(2, 0, 0, opusHead(1, 312)).subarray(0, 12));

    assert.equal(reader.incomplete, true);
  });

  it("refuses a stream that is not Ogg once there is enough of it to tell", () => {
    const reader = new OggOpusReader();

    assert.deepEqual(reader.push(Buffer.from("no")), [], "two bytes is not yet a verdict");
    assert.throws(() => reader.push(Buffer.from("t ogg at all")), /OggS/, "four is");
  });
});

describe("framesDueBy", () => {
  it("releases one 20 ms frame per 20 ms of wall clock", () => {
    assert.equal(framesDueBy(0), 0);
    assert.equal(framesDueBy(19), 0);
    assert.equal(framesDueBy(20), 1);
    assert.equal(framesDueBy(1_000), 50);
  });

  it("never asks for frames from before playback started", () => {
    assert.equal(framesDueBy(-500), 0);
  });
});

describe("rtpFrameAt", () => {
  const payload = Buffer.from([1]);
  const origin = { sequenceNumber: 65_534, timestamp: 0xffff_ff00 };

  it("advances the sequence number by one and the timestamp by a frame", () => {
    assert.equal(rtpFrameAt(payload, 0, origin).sequenceNumber, 65_534);
    assert.equal(rtpFrameAt(payload, 1, origin).sequenceNumber, 65_535);
    assert.equal(rtpFrameAt(payload, 0, origin).timestamp, 0xffff_ff00);
    assert.equal(rtpFrameAt(payload, 1, origin).timestamp, (0xffff_ff00 + opusFrameSamples) >>> 0);
  });

  it("wraps the sequence number at 16 bits and the timestamp at 32", () => {
    assert.equal(rtpFrameAt(payload, 2, origin).sequenceNumber, 0);
    assert.equal(rtpFrameAt(payload, 3, origin).sequenceNumber, 1);
    assert.ok(rtpFrameAt(payload, 1, origin).timestamp < 0xffff_ff00);
  });

  it("marks the first frame of playback, which is where the talkspurt starts", () => {
    assert.equal(rtpFrameAt(payload, 0, origin).marker, true);
    assert.equal(rtpFrameAt(payload, 1, origin).marker, false);
  });

  it("carries the payload it was handed, rather than choosing one", () => {
    // A Track ends. What happens then belongs to whatever owns the Queue, so
    // the arithmetic here knows nothing about how many packets there are.
    assert.equal(rtpFrameAt(payload, 9_999, origin).payload, payload);
  });
});

describe("toRtpPacket", () => {
  it("hands every Listener its own packet object", () => {
    // werift's sender rewrites ssrc, payload type, sequence number and
    // timestamp on the object it is given, and keeps it in a retransmission
    // cache, so one object shared between two Listeners ends up carrying the
    // other Listener's identity.
    const frame = rtpFrameAt(Buffer.from([9]), 0, { sequenceNumber: 7, timestamp: 21 });
    const first = toRtpPacket(frame);
    const second = toRtpPacket(frame);

    assert.notEqual(first, second);
    assert.notEqual(first.header, second.header);

    first.header.ssrc = 1234;
    first.header.payloadType = 96;

    assert.equal(second.header.ssrc, 0);
    assert.equal(second.header.sequenceNumber, 7);
    assert.equal(second.header.timestamp, 21);
  });

  it("carries the frame through unchanged", () => {
    const payload = Buffer.from([1, 2, 3]);
    const packet = toRtpPacket({ sequenceNumber: 5, timestamp: 960, marker: true, payload });

    assert.equal(packet.header.sequenceNumber, 5);
    assert.equal(packet.header.timestamp, 960);
    assert.equal(packet.header.marker, true);
    assert.deepEqual(packet.payload, payload);
  });
});

describe("opus framing constants", () => {
  it("keeps the frame size and its duration in step", () => {
    assert.equal(opusFrameSamples / 48, opusFrameMs);
  });
});

// Ogg fixtures. Only enough of the container to exercise the reader.

function opusHead(channels: number, preSkip: number) {
  const header = Buffer.alloc(19);
  header.write("OpusHead", 0, "ascii");
  header.writeUInt8(1, 8);
  header.writeUInt8(channels, 9);
  header.writeUInt16LE(preSkip, 10);
  header.writeUInt32LE(48_000, 12);
  return header;
}

function opusTags() {
  const tags = Buffer.alloc(16);
  tags.write("OpusTags", 0, "ascii");
  return tags;
}

function lacing(length: number) {
  const segments: number[] = [];
  while (length >= 255) {
    segments.push(255);
    length -= 255;
  }
  segments.push(length);
  return segments;
}

function page(headerType: number, granule: number, sequence: number, body: Buffer, segments = lacing(body.length)) {
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(headerType, 5);
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(0x564f_584c, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt8(segments.length, 26);
  Buffer.from(segments).copy(header, 27);
  return Buffer.concat([header, body]);
}

function oggFile(packets: Buffer[]) {
  return Buffer.concat(packets.map((packet, index) => page(index === 0 ? 2 : 0, index * 960, index, packet)));
}
