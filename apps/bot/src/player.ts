/**
 * One encoded Track, many Listeners.
 *
 * The Opus packets are read once and every Listener is handed the same bytes,
 * which is the property ADR-0002 is betting on: another Listener costs one more
 * SRTP encryption, not another encoder. What is deliberately *not* shared is
 * the packet object — see `toRtpPacket`.
 *
 * A Track now arrives while it plays rather than all at once (ADR-0004), so the
 * player pulls frames from a buffer that is still filling and has to answer for
 * the case where the next frame is not there yet. It stalls: the playback clock
 * stops rather than the frames being skipped. Skipping would mean the music
 * silently loses whatever the extractor was late by, and nobody would ever
 * learn which part of the Track they did not hear.
 *
 * The player also owns the answer to "is the bot making a sound right now",
 * because it is the only thing that knows. Nothing on the receiving side
 * measures incoming audio: the speaking indicator everyone renders comes from
 * the sender's own `voice:setMediaState`, so a bot that never reported would
 * play into a room where its own row stayed dark.
 */

import { MediaStreamTrack } from "werift";
import {
  TrackBuffer,
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
  /** The Track reached its end. Whoever owns the Queue decides what follows. */
  onEnded?: () => void;
}

export class TrackPlayer {
  /**
   * `markerSent` records whether this Listener has had the marker bit that
   * opens a talkspurt. It is cleared when the Listener's transport comes up,
   * when playback starts, and when a stall ends — the three moments audio
   * begins arriving after silence, and the only ones the marker bit means
   * anything at.
   */
  private readonly tracks = new Map<string, { track: MediaStreamTrack; markerSent: boolean }>();
  private readonly options: Required<Omit<TrackPlayerOptions, "onPlayingChange" | "onEnded">> &
    Pick<TrackPlayerOptions, "onPlayingChange" | "onEnded">;
  private timer?: NodeJS.Timeout;
  /**
   * Tracked separately from the timer handle rather than derived from it. What
   * `setInterval` returns is the host's to decide, and "is the bot making a
   * sound" is the answer the room is shown; it should not rest on a handle
   * happening to be truthy.
   */
  private isPlaying = false;
  private startedAt = 0;
  /** Position within the current Track. Resets when another one is loaded. */
  private sentFrames = 0;
  /**
   * Frames written to the wire since the Set began, which is what the sequence
   * numbers and timestamps are derived from. Deliberately *not* the same
   * counter as `sentFrames`: a Listener receives one continuous RTP stream for
   * as long as it is connected, and restarting its sequence numbering at the
   * start of every Track would look to the receiver like a flood of very old
   * packets arriving out of order.
   */
  private streamFrames = 0;
  private stalled = false;
  private ended = false;
  private source: TrackBuffer | null = null;
  private readonly origin: RtpOrigin;

  constructor(options: TrackPlayerOptions = {}) {
    this.options = {
      now: options.now ?? (() => performance.now()),
      setInterval: options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds)),
      clearInterval: options.clearInterval ?? ((timer) => clearInterval(timer)),
      onPlayingChange: options.onPlayingChange,
      onEnded: options.onEnded
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

  /**
   * The Track to play from here. Replaces whatever was loaded, from its
   * beginning, without disturbing the RTP stream the Listeners are receiving.
   */
  load(source: TrackBuffer) {
    this.source = source;
    this.sentFrames = 0;
    this.ended = false;
    this.stalled = false;
    this.rebaseClock();
    // A new Track after another one is a new talkspurt, even without a gap.
    this.reopenTalkspurts();
  }

  start() {
    if (this.isPlaying || !this.source) return;
    // A Track that already reached its end is not played again from here.
    //
    // This used to replay it, on the grounds that a Play button which did
    // nothing would look broken. The Queue took that argument away: what
    // follows a Track is the Queue's answer, and a `play` for audio the Queue
    // has not just loaded can only be a mistake above. Replaying then means the
    // room hears the wrong Track, which is a worse failure than hearing
    // nothing and a much harder one to recognise. Loading a Track clears this,
    // so every real advance still plays.
    if (this.ended) return;
    this.isPlaying = true;
    this.rebaseClock();
    // Tick faster than the frame rate and send whatever is due. A 20 ms
    // interval drifts; catching up against the clock does not.
    this.timer = this.options.setInterval(() => this.flush(), Math.floor(opusFrameMs / 4));
    // Resuming after a stop is a new talkspurt for everyone still listening.
    this.reopenTalkspurts();
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

  /**
   * Whether playback is waiting on audio that has not been fetched yet. It is
   * not a kind of stopped: the bot is still playing this Track and still says
   * so, it just has nothing to send this instant.
   */
  get waiting() {
    return this.stalled;
  }

  /** Exposed so a test can advance playback without waiting for a timer. */
  flush() {
    const source = this.source;
    if (!this.isPlaying || !source) return;
    // Nothing goes out until the prebuffer is met, and while it is not, the
    // clock does not run either — otherwise the wait would be owed back as a
    // burst of frames the moment audio arrived.
    if (!source.readyToStart) {
      this.enterStall();
      return;
    }
    const due = framesDueBy(this.options.now() - this.startedAt);
    while (this.sentFrames < due) {
      const payload = source.packetAt(this.sentFrames);
      if (payload === undefined) {
        if (source.complete) {
          this.finish();
          return;
        }
        this.enterStall();
        return;
      }
      if (this.stalled) this.leaveStall();
      const frame = rtpFrameAt(payload, this.streamFrames, this.origin);
      // The Track's own first frame opens a talkspurt; so does the first frame
      // a Listener can actually receive, for one that arrived mid-Track and
      // whose jitter buffer has nothing else to sync to.
      const marker = this.sentFrames === 0;
      for (const entry of this.tracks.values()) {
        entry.track.writeRtp(toRtpPacket({ ...frame, marker: marker || !entry.markerSent }));
        entry.markerSent = true;
      }
      this.sentFrames++;
      this.streamFrames++;
    }
  }

  /**
   * Stops the clock where playback got to, so the stalled stretch is never owed
   * back. `speaking` deliberately does not change: the bot is still playing
   * this Track, and flickering the room's indicator off and on for a
   * half-second of buffering would report a state nobody is in.
   */
  private enterStall() {
    this.rebaseClock();
    this.stalled = true;
  }

  private leaveStall() {
    this.stalled = false;
    // Audio resuming after silence is a new talkspurt, exactly as it is after a
    // stop; the receiving jitter buffer has nothing else to resynchronise on.
    this.reopenTalkspurts();
  }

  private finish() {
    this.ended = true;
    this.stop();
    this.options.onEnded?.();
  }

  private rebaseClock() {
    this.startedAt = this.options.now() - this.sentFrames * opusFrameMs;
  }

  private reopenTalkspurts() {
    for (const entry of this.tracks.values()) entry.markerSent = false;
  }
}
