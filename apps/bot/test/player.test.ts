import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RtpPacket } from "werift";
import { TrackBuffer, prebufferFrames } from "../src/audio.js";
import { TrackPlayer } from "../src/player.js";

/**
 * The player is driven by an injected clock here rather than by a timer, so
 * these assertions are about what is written and to whom, not about how long
 * anything took.
 */

/**
 * Long enough to get past the prebuffer without a stall, so a test that is not
 * about buffering does not have to think about it. `packetAt` is deterministic
 * per index, which is what lets an assertion name the frame it expects.
 */
const packets = Array.from({ length: prebufferFrames + 20 }, (_, index) => Buffer.from([index & 0xff, 1]));

function testPlayer(
  options: {
    onPlayingChange?: (playing: boolean) => void;
    onEnded?: () => void;
    /** A partly-fetched Track, still filling. Complete by default. */
    source?: TrackBuffer;
  } = {}
) {
  let clock = 0;
  const source = options.source ?? TrackBuffer.of(packets);
  const player = new TrackPlayer({
    now: () => clock,
    // Playback is stepped by hand; the interval must never fire on its own.
    setInterval: () => 0 as unknown as NodeJS.Timeout,
    clearInterval: () => undefined,
    onPlayingChange: options.onPlayingChange,
    onEnded: options.onEnded
  });
  player.load(source);
  return {
    player,
    source,
    advance(milliseconds: number) {
      clock += milliseconds;
      player.flush();
    }
  };
}

function capture(track: { onReceiveRtp?: unknown; writeRtp: (packet: RtpPacket) => void }) {
  const written: RtpPacket[] = [];
  const original = track.writeRtp.bind(track);
  track.writeRtp = (packet: RtpPacket) => {
    written.push(packet);
    original(packet);
  };
  return written;
}

describe("one Track, many Listeners", () => {
  it("hands every Listener the very same payload buffer, not a copy of it", () => {
    // Identity rather than equality on purpose. Equal bytes would also be what
    // a per-Listener encode produced; the same object is what proves the Track
    // was encoded once, which is the property ADR-0002 chose the library for.
    const { player, advance } = testPlayer();
    const first = capture(player.outputFor("ada"));
    const second = capture(player.outputFor("bo"));

    player.start();
    advance(100);

    assert.equal(first.length, 5);
    assert.equal(second.length, 5);
    for (let index = 0; index < first.length; index += 1) {
      assert.equal(first[index]?.payload, second[index]?.payload, `frame ${index} must be one buffer, shared`);
      assert.equal(first[index]?.payload, packets[index], "and it must be the Track's own buffer");
    }
  });

  it("gives each Listener its own packet object, not a shared one", () => {
    // The sender mutates what it is handed and keeps it. Sharing one object
    // leaves each Listener's retransmission cache holding another's header.
    const { player, advance } = testPlayer();
    const first = capture(player.outputFor("ada"));
    const second = capture(player.outputFor("bo"));

    player.start();
    advance(20);

    assert.notEqual(first[0], second[0]);
    assert.notEqual(first[0]?.header, second[0]?.header);
  });

  it("keeps sending to the Listeners who stayed when one is released", () => {
    const { player, advance } = testPlayer();
    const staying = capture(player.outputFor("ada"));
    const leaving = capture(player.outputFor("bo"));

    player.start();
    advance(40);
    player.release("bo");
    advance(40);

    assert.equal(leaving.length, 2, "a released Listener stops receiving");
    assert.equal(staying.length, 4, "everyone else carries on uninterrupted");
  });

  it("starts a Listener that arrived mid-Track on the packet it can first receive", () => {
    const { player, advance } = testPlayer();
    capture(player.outputFor("ada"));
    player.start();
    advance(200);

    const late = capture(player.outputFor("bo"));
    // Nothing written before the transport came up ever arrived, so the marker
    // belongs on the first frame after it did, not on the first one written.
    advance(20);
    assert.equal(late[0]?.header.marker, true);
    player.startTalkspurt("bo");
    advance(20);
    assert.equal(late[1]?.header.marker, true);
    advance(20);
    assert.equal(late[2]?.header.marker, false);
  });
});

describe("playback state", () => {
  it("reports starting and stopping exactly once each", () => {
    const changes: boolean[] = [];
    const { player } = testPlayer({ onPlayingChange: (playing) => changes.push(playing) });

    player.start();
    player.start();
    player.stop();
    player.stop();

    assert.deepEqual(changes, [true, false]);
    assert.equal(player.playing, false);
  });

  it("resumes where it stopped rather than replaying the whole Track at once", () => {
    const { player, advance } = testPlayer();
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(100);
    player.stop();
    advance(1_000);
    player.start();
    advance(40);

    assert.equal(written.length, 7, "the silent stretch is skipped, not caught up on");
  });

  it("treats a resume as a new talkspurt", () => {
    const { player, advance } = testPlayer();
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(100);
    player.stop();
    player.start();
    advance(20);

    assert.equal(written[5]?.header.marker, true);
  });

  it("reports stopping when the Set closes, so the room does not stay lit", () => {
    const changes: boolean[] = [];
    const { player } = testPlayer({ onPlayingChange: (playing) => changes.push(playing) });
    player.outputFor("ada");

    player.start();
    player.close();

    assert.deepEqual(changes, [true, false]);
  });

  it("plays nothing at all until a Track is loaded", () => {
    const changes: boolean[] = [];
    const player = new TrackPlayer({ onPlayingChange: (playing) => changes.push(playing) });
    const written = capture(player.outputFor("ada"));

    player.start();

    assert.equal(player.playing, false, "there is nothing to play");
    assert.deepEqual(changes, [], "and nothing to report to the room");
    assert.deepEqual(written, []);
  });
});

describe("a Track that is still being fetched", () => {
  /** A Track arriving in pieces, as the extractor actually delivers one. */
  function filling(initial = 0) {
    const source = new TrackBuffer();
    source.append(packets.slice(0, initial));
    return source;
  }

  it("waits for the prebuffer before the first note", () => {
    // Starting on the first frame that arrives would put the music one hiccup
    // away from a gap for its whole length.
    const source = filling(prebufferFrames - 1);
    const { player, advance } = testPlayer({ source });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(200);

    assert.equal(written.length, 0, "nothing goes out on a half-filled buffer");
    assert.equal(player.waiting, true);
    assert.equal(player.playing, true, "waiting is not stopped: this Track is still the one playing");

    source.append(packets.slice(prebufferFrames - 1, prebufferFrames));
    advance(20);

    assert.equal(written.length, 1, "and it starts at the beginning, not part-way in");
    assert.equal(written[0]?.payload, packets[0]);
  });

  it("does not owe back the time it spent waiting", () => {
    // The whole point of stopping the clock. A player that kept counting would
    // dump every frame of the wait onto the wire the instant audio arrived,
    // which the receiving jitter buffer would discard as a flood.
    const source = filling();
    const { player, advance } = testPlayer({ source });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(5_000);
    source.append(packets);
    advance(100);

    assert.equal(written.length, 5, "five frames for 100 ms, not 255 for the wait as well");
  });

  it("stalls mid-Track when the extractor falls behind, then carries on where it stopped", () => {
    const source = filling(prebufferFrames);
    const { player, advance } = testPlayer({ source });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(prebufferFrames * 20);
    assert.equal(written.length, prebufferFrames);
    assert.equal(player.waiting, false);

    advance(1_000);
    assert.equal(written.length, prebufferFrames, "there is nothing to send, so nothing is sent");
    assert.equal(player.waiting, true);
    assert.equal(player.playing, true);

    source.append(packets.slice(prebufferFrames));
    advance(40);

    assert.equal(written.length, prebufferFrames + 2, "resumes at two frames per 40 ms");
    assert.equal(written[prebufferFrames]?.payload, packets[prebufferFrames], "and at the frame it stopped on");
    assert.equal(player.waiting, false);
  });

  it("opens a new talkspurt when a stall ends", () => {
    // Audio resuming after silence needs a marker, or the receiver's jitter
    // buffer has nothing to resynchronise on.
    const source = filling(prebufferFrames);
    const { player, advance } = testPlayer({ source });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(prebufferFrames * 20 + 1_000);
    source.append(packets.slice(prebufferFrames));
    advance(40);

    assert.equal(written[prebufferFrames]?.header.marker, true, "the frame that ends the silence opens a talkspurt");
    assert.equal(written[prebufferFrames + 1]?.header.marker, false, "the one after it is ordinary");
  });

  it("does not tell the room it stopped speaking merely because it is buffering", () => {
    // The indicator would flicker off and on for half a second of buffering,
    // reporting a state the bot is not in. It is still playing this Track.
    const changes: boolean[] = [];
    const source = filling(prebufferFrames);
    const { player, advance } = testPlayer({ source, onPlayingChange: (playing) => changes.push(playing) });
    player.outputFor("ada");

    player.start();
    advance(prebufferFrames * 20 + 2_000);

    assert.deepEqual(changes, [true]);
  });

  it("ends the Track when the fetch finishes and the last frame has gone out", () => {
    const ended: number[] = [];
    const source = filling(3);
    const { player, advance } = testPlayer({ source, onEnded: () => ended.push(1) });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(1_000);
    assert.equal(ended.length, 0, "still fetching: an absent frame is a wait, not an end");

    source.finish();
    advance(100);

    assert.deepEqual(ended, [1]);
    assert.equal(written.length, 3, "every frame that was fetched is played first");
    assert.equal(player.playing, false, "and the room stops seeing the bot as speaking");
  });

  it("does not report the end twice for one pass of a Track", () => {
    const ended: number[] = [];
    const { player, advance } = testPlayer({ source: TrackBuffer.of(packets.slice(0, 2)), onEnded: () => ended.push(1) });

    player.start();
    advance(1_000);
    advance(1_000);

    assert.deepEqual(ended, [1]);
  });

  it("does not replay a Track that already finished", () => {
    // What follows a Track is the Queue's answer, and the Queue loads whatever
    // it wants played. A `play` for audio it did not just load can only be a
    // mistake above this — and replaying on one would put the wrong Track in
    // front of the room, which is worse than silence and much harder to spot.
    const ended: number[] = [];
    const { player, advance } = testPlayer({ source: TrackBuffer.of(packets.slice(0, 2)), onEnded: () => ended.push(1) });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(1_000);
    assert.equal(player.playing, false);

    player.start();
    advance(40);

    assert.equal(player.playing, false);
    assert.equal(written.length, 2, "the Track played once");
    assert.deepEqual(ended, [1], "and its end was reported once");
  });
});

describe("one Set, several Tracks", () => {
  it("keeps the Listener's RTP stream running forward across a Track change", () => {
    // A Listener receives one continuous stream for as long as it is connected.
    // Restarting the sequence numbering at each Track would look to the
    // receiver like a flood of very old packets arriving out of order.
    const { player, advance } = testPlayer();
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(100);
    player.load(TrackBuffer.of(packets));
    player.start();
    advance(100);

    const sequence = written.map((packet) => packet.header.sequenceNumber);
    for (let index = 1; index < sequence.length; index += 1) {
      assert.equal(sequence[index], (sequence[index - 1]! + 1) & 0xffff, `frame ${index} must follow the one before`);
    }
    assert.ok(written.length > 5, "the second Track really did play");
  });

  it("plays the next Track from its own beginning", () => {
    const { player, advance } = testPlayer();
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(100);
    player.load(TrackBuffer.of(packets));
    player.start();
    advance(20);

    assert.equal(written[5]?.payload, packets[0], "the new Track starts at its first frame");
    assert.equal(written[5]?.header.marker, true, "and opens a talkspurt of its own");
  });

  it("plays again after a Track that had already ended", () => {
    const { player, advance } = testPlayer({ source: TrackBuffer.of(packets.slice(0, 2)) });
    const written = capture(player.outputFor("ada"));

    player.start();
    advance(1_000);
    assert.equal(player.playing, false);

    player.load(TrackBuffer.of(packets));
    player.start();
    advance(40);

    assert.equal(player.playing, true, "loading a Track clears the end of the previous one");
    assert.equal(written.length, 4);
  });
});
