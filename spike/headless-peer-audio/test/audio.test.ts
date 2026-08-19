import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  bundledTrackPath,
  framesDueBy,
  opusFrameMs,
  opusFrameSamples,
  readOggOpus,
  rtpFrameAt,
  toRtpPacket
} from "../src/audio.js";

describe("readOggOpus", () => {
  it("reads the bundled Track's header and audio packets", () => {
    const file = readOggOpus(readFileSync(bundledTrackPath));

    assert.equal(file.channels, 1);
    assert.equal(file.preSkip, 312);
    assert.ok(file.packets.length > 100, `expected a few seconds of audio, got ${file.packets.length} packets`);
    assert.ok(file.packets.every((packet) => packet.length > 0));
  });

  it("drops the two header packets rather than sending them as audio", () => {
    const file = readOggOpus(readFileSync(bundledTrackPath));

    assert.ok(!file.packets.some((packet) => packet.subarray(0, 8).toString("ascii") === "OpusHead"));
    assert.ok(!file.packets.some((packet) => packet.subarray(0, 8).toString("ascii") === "OpusTags"));
  });

  it("reassembles a packet that spans several lacing segments", () => {
    // A 600-byte packet laces as 255, 255, 90. A reader that treats every
    // segment as a packet would send three fragments and produce noise.
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
  const packets = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
  const origin = { sequenceNumber: 65_534, timestamp: 0xffff_ff00 };

  it("advances the sequence number by one and the timestamp by a frame", () => {
    assert.equal(rtpFrameAt(packets, 0, origin).sequenceNumber, 65_534);
    assert.equal(rtpFrameAt(packets, 1, origin).sequenceNumber, 65_535);
    assert.equal(rtpFrameAt(packets, 0, origin).timestamp, 0xffff_ff00);
    assert.equal(rtpFrameAt(packets, 1, origin).timestamp, (0xffff_ff00 + opusFrameSamples) >>> 0);
  });

  it("wraps the sequence number at 16 bits and the timestamp at 32", () => {
    assert.equal(rtpFrameAt(packets, 2, origin).sequenceNumber, 0);
    assert.equal(rtpFrameAt(packets, 3, origin).sequenceNumber, 1);
    assert.equal(rtpFrameAt(packets, 1, origin).timestamp < 0xffff_ff00, true);
  });

  it("marks only the first frame, which is where the talkspurt starts", () => {
    assert.equal(rtpFrameAt(packets, 0, origin).marker, true);
    assert.equal(rtpFrameAt(packets, 1, origin).marker, false);
  });

  it("loops back to the first packet when the Track ends", () => {
    assert.deepEqual(rtpFrameAt(packets, 3, origin).payload, packets[0]);
    assert.deepEqual(rtpFrameAt(packets, 4, origin).payload, packets[1]);
  });
});

describe("toRtpPacket", () => {
  it("hands every Listener its own packet object", () => {
    // werift's sender rewrites ssrc, payload type, sequence number and
    // timestamp on the object it is given, so one object shared between two
    // Listeners ends up carrying the other Listener's identity.
    const frame = rtpFrameAt([Buffer.from([9])], 0, { sequenceNumber: 7, timestamp: 21 });
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
