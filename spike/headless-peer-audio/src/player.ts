import { MediaStreamTrack } from "werift";
import { framesDueBy, opusFrameMs, rtpFrameAt, toRtpPacket, type RtpOrigin } from "./audio.js";

/**
 * One encoded Track, many Listeners.
 *
 * The Opus packets are read once and every Listener is handed the same bytes,
 * which is the property the architecture rests on: another Listener costs one
 * more SRTP encryption, not another encoder. What is *not* shared is the packet
 * object — see `toRtpPacket`.
 */
export class TrackPlayer {
  private readonly tracks = new Map<string, { track: MediaStreamTrack; sent: number }>();
  private timer?: NodeJS.Timeout;
  private startedAt = 0;
  private sentFrames = 0;
  private readonly origin: RtpOrigin;

  constructor(private readonly packets: Buffer[]) {
    if (packets.length === 0) throw new Error("The Track has no audio packets");
    // RFC 3550: both must start at a random value.
    this.origin = {
      sequenceNumber: Math.floor(Math.random() * 0xffff),
      timestamp: Math.floor(Math.random() * 0xffff_ffff) >>> 0
    };
  }

  /**
   * The audio this Listener receives — a WebRTC track, not a Track. Created on
   * demand, one per Listener, all fed from the same encoded packets.
   */
  outputFor(userId: string) {
    const existing = this.tracks.get(userId);
    if (existing) return existing.track;
    const track = new MediaStreamTrack({ kind: "audio" });
    this.tracks.set(userId, { track, sent: 0 });
    return track;
  }

  release(userId: string) {
    const entry = this.tracks.get(userId);
    if (!entry) return;
    this.tracks.delete(userId);
    entry.track.stop();
  }

  start() {
    if (this.timer) return;
    // Offset by what has already gone out, so a stop/start resumes rather than
    // asking for every frame since zero all at once.
    this.startedAt = performance.now() - this.sentFrames * opusFrameMs;
    // Tick faster than the frame rate and send whatever is due. A 20 ms
    // interval drifts; catching up against the clock does not.
    this.timer = setInterval(() => this.flush(), Math.floor(opusFrameMs / 4));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const userId of [...this.tracks.keys()]) this.release(userId);
  }

  get progress() {
    return {
      seconds: (this.sentFrames * opusFrameMs) / 1_000,
      listeners: this.tracks.size,
      loops: Math.floor(this.sentFrames / this.packets.length)
    };
  }

  private flush() {
    const due = framesDueBy(performance.now() - this.startedAt);
    while (this.sentFrames < due) {
      const frame = rtpFrameAt(this.packets, this.sentFrames, this.origin);
      for (const entry of this.tracks.values()) {
        // A Listener who arrived mid-Track still needs a marker on its first
        // packet, or its jitter buffer has no start of talkspurt to sync to.
        entry.track.writeRtp(toRtpPacket({ ...frame, marker: frame.marker || entry.sent === 0 }));
        entry.sent++;
      }
      this.sentFrames++;
    }
  }
}
