import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RtpPacket } from "werift";
import { TrackPlayer } from "../src/player.js";

/**
 * The player is driven by an injected clock here rather than by a timer, so
 * these assertions are about what is written and to whom, not about how long
 * anything took.
 */

const packets = [Buffer.from([1, 1]), Buffer.from([2, 2]), Buffer.from([3, 3])];

function testPlayer(options: { onPlayingChange?: (playing: boolean) => void } = {}) {
  let clock = 0;
  const player = new TrackPlayer(packets, {
    now: () => clock,
    // Playback is stepped by hand; the interval must never fire on its own.
    setInterval: () => 0 as unknown as NodeJS.Timeout,
    clearInterval: () => undefined,
    onPlayingChange: options.onPlayingChange
  });
  return {
    player,
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
      assert.equal(first[index]?.payload, packets[index % packets.length], "and it must be the Track's own buffer");
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

  it("refuses a Track with no audio in it", () => {
    assert.throws(() => new TrackPlayer([]), /no audio packets/);
  });
});
