/**
 * One encoded Track, many Listeners.
 *
 * The Opus packets are read once and every Listener is handed the same bytes,
 * which is the property ADR-0002 is betting on: another Listener costs one more
 * SRTP encryption, not another encoder. What is deliberately *not* shared is
 * the packet object — see `toRtpPacket`.
 *
 * The player also owns the answer to "is the bot making a sound right now",
 * because it is the only thing that knows. Nothing on the receiving side
 * measures incoming audio: the speaking indicator everyone renders comes from
 * the sender's own `voice:setMediaState`, so a bot that never reported would
 * play into a room where its own row stayed dark.
 */

import { MediaStreamTrack } from "werift";
import {
  framesDueBy,
  opusFrameMs,
  randomRtpOrigin,
  rtpFrameAt,
  toRtpPacket,
  type RtpOrigin
} from "./audio.js";

export interface TrackPlayerOptions {
  /** Injected in tests so playback can be stepped rather than waited out. */
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  /** Called when playback starts or stops, so the Set can publish `speaking`. */
  onPlayingChange?: (playing: boolean) => void;
}

export class TrackPlayer {
  /**
   * `markerSent` records whether this Listener has had the marker bit that
   * opens a talkspurt. It is cleared when the Listener's transport comes up and
   * when playback starts, which are the two moments audio begins arriving after
   * silence — the only two the marker bit means anything at.
   */
  private readonly tracks = new Map<string, { track: MediaStreamTrack; markerSent: boolean }>();
  private readonly options: Required<Omit<TrackPlayerOptions, "onPlayingChange">> & Pick<TrackPlayerOptions, "onPlayingChange">;
  private timer?: NodeJS.Timeout;
  /**
   * Tracked separately from the timer handle rather than derived from it. What
   * `setInterval` returns is the host's to decide, and "is the bot making a
   * sound" is the answer the room is shown; it should not rest on a handle
   * happening to be truthy.
   */
  private isPlaying = false;
  private startedAt = 0;
  private sentFrames = 0;
  private readonly origin: RtpOrigin;

  constructor(private readonly packets: Buffer[], options: TrackPlayerOptions = {}) {
    if (packets.length === 0) throw new Error("The Track has no audio packets");
    this.options = {
      now: options.now ?? (() => performance.now()),
      setInterval: options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds)),
      clearInterval: options.clearInterval ?? ((timer) => clearInterval(timer)),
      onPlayingChange: options.onPlayingChange
    };
    this.origin = randomRtpOrigin();
  }

  /**
   * The audio one Listener receives — a WebRTC track, not a Track. Created on
   * demand, one per Listener, all fed from the same encoded packets.
   */
  outputFor(userId: string) {
    const existing = this.tracks.get(userId);
    if (existing) return existing.track;
    const track = new MediaStreamTrack({ kind: "audio" });
    this.tracks.set(userId, { track, markerSent: false });
    return track;
  }

  /**
   * This Listener's transport just came up, so the frames it has been written
   * so far never reached it. The next one starts its talkspurt.
   */
  startTalkspurt(userId: string) {
    const entry = this.tracks.get(userId);
    if (entry) entry.markerSent = false;
  }

  release(userId: string) {
    const entry = this.tracks.get(userId);
    if (!entry) return;
    this.tracks.delete(userId);
    entry.track.stop();
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    // Offset by what has already gone out, so a stop/start resumes rather than
    // asking for every frame since zero all at once.
    this.startedAt = this.options.now() - this.sentFrames * opusFrameMs;
    // Tick faster than the frame rate and send whatever is due. A 20 ms
    // interval drifts; catching up against the clock does not.
    this.timer = this.options.setInterval(() => this.flush(), Math.floor(opusFrameMs / 4));
    // Resuming after a stop is a new talkspurt for everyone still listening.
    for (const entry of this.tracks.values()) entry.markerSent = false;
    this.options.onPlayingChange?.(true);
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.timer !== undefined) this.options.clearInterval(this.timer);
    this.timer = undefined;
    this.options.onPlayingChange?.(false);
  }

  /** Stops and drops every output. The Set is over; nothing resumes from here. */
  close() {
    this.stop();
    for (const userId of [...this.tracks.keys()]) this.release(userId);
  }

  get playing() {
    return this.isPlaying;
  }

  /** Exposed so a test can advance playback without waiting for a timer. */
  flush() {
    if (!this.isPlaying) return;
    const due = framesDueBy(this.options.now() - this.startedAt);
    while (this.sentFrames < due) {
      const frame = rtpFrameAt(this.packets, this.sentFrames, this.origin);
      for (const entry of this.tracks.values()) {
        // A Listener who arrived mid-Track still needs a marker on the first
        // packet it can actually receive, or its jitter buffer has no start of
        // talkspurt to sync to.
        entry.track.writeRtp(toRtpPacket({ ...frame, marker: frame.marker || !entry.markerSent }));
        entry.markerSent = true;
      }
      this.sentFrames++;
    }
  }
}
