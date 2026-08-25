/**
 * Fetching a Track: the thin adapter around two external programs.
 *
 * This is the audio-provider half of the split the design keeps: `track.ts`
 * turns what a member typed into the identity of a Track, and this turns that
 * identity into playable audio. There is exactly one audio provider and there
 * is meant to be: a future Spotify link would be another *resolver* that finds
 * the named Track here, never another source of audio.
 *
 * Both programs are spawned, never shelled. No part of a member's input reaches
 * a shell, and the URL that does reach yt-dlp was rebuilt from a validated
 * eleven-character id rather than passed through.
 *
 * Nothing here is unit tested, and it is worth being precise about why rather
 * than claiming there is nothing in it to test. It does hold decisions: three
 * argument lists — a link's, a search's and the encoder's — three timeouts, and
 * the rule that only the *encoder's* exit ends a Track. What none of them have
 * is a failure a unit test could catch — a test would pin the argument list to
 * itself and prove only that it had been copied correctly, while the way these
 * actually go wrong is that a flag means something other than what was
 * intended. Only the real binaries can say. So this is verified by the
 * end-to-end check in `AGENTS.md`, and the decisions that *can* be tested were
 * deliberately put in `track.ts`, which is pure and covered.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { musicSearchResultsMax } from "@voxly/shared";
import type { BotEnvironment } from "./config.js";
import { OggOpusReader, TrackBuffer } from "./audio.js";
import {
  classifyExtractorFailure,
  parseSearchResults,
  parseTrackMetadata,
  type SearchResult,
  type TrackResult,
  type Track
} from "./track.js";

/**
 * How long the extractor gets to answer with a Track's details.
 *
 * Must stay comfortably *under* the server's `botAckTimeoutMs`, together with
 * the join that follows it. A bot cut off by the server reports `bot_timeout`
 * in place of the reason it actually gave up, which tells the member nothing.
 */
export const resolveTimeoutMs = 15_000;

/**
 * How long a search gets to answer.
 *
 * Shorter than a resolve, and not because it matters less: a flat listing does
 * no per-video extraction, so it is one cheap round trip and a slow one is not
 * a search that is nearly finished. Spending less than a resolve does is what
 * keeps a member who typed a name from watching a panel do nothing for a
 * quarter of a minute.
 *
 * The margin it has to fit in is **two of these**, not one. Searches are
 * serialised among themselves (`music.ts`), so a member whose search arrives
 * while another is running waits out both before the server's
 * `botAckTimeoutMs` of 25s cuts them off and reports `bot_timeout` in place of
 * an answer. Nothing else is in that budget: a search Summons nothing, so no
 * join follows it.
 */
export const searchTimeoutMs = 10_000;

/**
 * How long the whole fetch gets before it is abandoned mid-Track.
 *
 * A bound on a runaway process rather than a limit on Track length: it has to
 * exceed the longest Track anyone would reasonably queue, fetched over a line
 * being throttled, because reaching it truncates the music without asking.
 */
export const fetchTimeoutMs = 30 * 60_000;

/**
 * A ceiling on the metadata the extractor may hand back. The source chooses how
 * much that is, and this process is long-lived.
 */
const maxMetadataBytes = 4 * 1_024 * 1_024;

/**
 * The encoder settings, fixed rather than adapted per Listener.
 *
 * One encode serves every Listener (ADR-0002), so there is no per-peer rate to
 * adapt to — a bitrate chosen for the worst connection in the room is the one
 * everybody gets, which is what makes it fair rather than merely simple.
 * 96 kbps stereo is conservative for music; in-band FEC and 20 ms frames match
 * what the browser negotiates and what `audio.ts` assumes.
 */
const encoderArguments = [
  "-loglevel", "error",
  "-i", "pipe:0",
  // The first audio stream of the first input, and nothing else. `bestaudio`
  // usually yields audio alone, but it falls back to `best`, which is a video
  // file that happens to carry some. The file index is not optional here:
  // `-map a:0` reads "a" as an input index and fails.
  "-map", "0:a:0",
  "-vn",
  "-c:a", "libopus",
  "-b:a", "96k",
  "-ar", "48000",
  "-ac", "2",
  "-application", "audio",
  "-frame_duration", "20",
  "-fec", "1",
  "-packet_loss", "5",
  // The Ogg Opus muxer. Asking for a container rather than a raw stream is what
  // keeps this on the same framing path as a file on disk — see ADR-0004.
  "-f", "opus",
  "pipe:1"
];

/** yt-dlp arguments common to both what it is asked to do. */
function extractorArguments(environment: BotEnvironment, url: string) {
  return [
    // A link may carry a playlist with it. Explicitly one video: queueing a
    // whole playlist is out of scope, and doing it by accident would be worse.
    "--no-playlist",
    "--no-warnings",
    // The bot has no terminal, no cache directory it may write, and nothing to
    // gain from a partial file on a read-only filesystem.
    "--no-progress",
    "--no-cache-dir",
    "--socket-timeout", "15",
    "-f", "bestaudio/best",
    ...(environment.extractorClient
      ? ["--extractor-args", `youtube:player_client=${environment.extractorClient}`]
      : []),
    url
  ];
}

export interface TrackAudio {
  /** Fills as the fetch proceeds. Handed to a player, which reads it as it goes. */
  buffer: TrackBuffer;
  /** Abandons the fetch. Safe to call after it has already finished. */
  cancel: () => void;
}

/**
 * What the extractor knows about a link, without fetching any audio.
 *
 * Separate from the fetch because it is the fast half and the one a member is
 * waiting on: it is what turns a pasted link into "that video is unavailable"
 * within a second or two, rather than into a room where nothing happens.
 */
export async function resolveTrack(environment: BotEnvironment, url: string): Promise<TrackResult> {
  const child = spawn(environment.extractorPath, ["--dump-single-json", ...extractorArguments(environment, url)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const finished = await collect(child, resolveTimeoutMs);

  // A binary that could not be run at all is a deployment fault, not YouTube
  // refusing anything. Telling the member to try again in a few minutes would
  // send them to wait out something that will never change on its own.
  if (finished.spawnError) return { ok: false, error: "bot_failed" };
  if (finished.code !== 0) return { ok: false, error: classifyExtractorFailure(finished.stderr) };
  return parseTrackMetadata(finished.stdout);
}

/**
 * What the source offers for a typed name.
 *
 * A **flat** listing on purpose: one request that returns what the search page
 * already knew about each result, rather than a full extraction per result,
 * which would be five round trips against a source that rate-limits by address
 * for four Tracks nobody is going to play. What comes back is enough to choose
 * between — a title, a length, a channel — and the one that is chosen is then
 * resolved properly through `resolveTrack`, exactly as a pasted link is.
 *
 * The name never reaches a shell. It is one argument in a list, and the count
 * in front of it is derived from the shared bound rather than written here.
 */
export async function searchTracks(environment: BotEnvironment, name: string): Promise<SearchResult> {
  const child = spawn(environment.extractorPath, searchArguments(environment, name), {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const finished = await collect(child, searchTimeoutMs);

  if (finished.spawnError) return { ok: false, error: "bot_failed" };
  // Not `classifyExtractorFailure`: that answers "was it the video or the
  // extractor", and a search has no video to blame. Whatever went wrong here is
  // between the bot and the source, which is what `extractor_failed` says.
  if (finished.code !== 0) return { ok: false, error: "extractor_failed" };
  return parseSearchResults(finished.stdout);
}

/**
 * The search's own argument list, kept apart from the one a link uses rather
 * than shared with a flag. `--no-playlist` would be actively wrong here — a
 * search *is* a playlist — and a format selector means nothing to a listing
 * that fetches no media. The extractor client stays, because it is the
 * operator's one lever over how yt-dlp presents itself to the source, and a
 * search is a request to the same source.
 */
function searchArguments(environment: BotEnvironment, name: string) {
  return [
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-cache-dir",
    "--socket-timeout", "15",
    ...(environment.extractorClient
      ? ["--extractor-args", `youtube:player_client=${environment.extractorClient}`]
      : []),
    // Ask for more than will be shown. A live stream or a premiere among the
    // hits is not a Result and gets dropped, so asking for exactly five would
    // hand a member three — or, for a name whose every hit is a broadcast,
    // "nothing matched that" for something that plainly did. The extra costs
    // nothing: it is the same one request, and `parseSearchResults` stops at
    // the bound regardless.
    `ytsearch${musicSearchResultsMax * 2}:${name}`
  ];
}

/**
 * Starts fetching a Track's audio and hands back a buffer that fills as it
 * arrives. It returns as soon as the processes are running rather than when the
 * audio is complete, because playback starts long before that (ADR-0004).
 *
 * A failure part-way through ends the buffer rather than throwing at nobody:
 * the caller is a player that is already sending frames, and what it needs is
 * for the Track to end where the audio did.
 */
export function fetchTrackAudio(
  environment: BotEnvironment,
  track: Track,
  log: (message: string) => void
): TrackAudio {
  const buffer = new TrackBuffer();
  const reader = new OggOpusReader();

  const extractor = spawn(environment.extractorPath, ["-o", "-", ...extractorArguments(environment, track.url)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const encoder = spawn(environment.encoderPath, encoderArguments, { stdio: ["pipe", "pipe", "pipe"] });

  let done = false;
  const finish = (why: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (reader.incomplete) log(`the audio for ${track.id} ended mid-stream (${why})`);
    buffer.finish();
    extractor.kill("SIGKILL");
    encoder.kill("SIGKILL");
  };
  const timer = setTimeout(() => finish(`nothing finished within ${fetchTimeoutMs} ms`), fetchTimeoutMs);
  timer.unref?.();

  extractor.stdout.pipe(encoder.stdin);
  // A killed encoder leaves the extractor writing into a closed pipe. That is
  // an expected end rather than a fault, and an unhandled EPIPE on a stream
  // takes the process down.
  encoder.stdin.on("error", () => undefined);
  extractor.stdout.on("error", () => undefined);

  encoder.stdout.on("data", (chunk: Buffer) => {
    try {
      buffer.append(reader.push(chunk));
    } catch (cause) {
      log(`the audio for ${track.id} was not readable: ${String(cause)}`);
      finish("unreadable");
    }
  });
  encoder.stdout.on("end", () => finish("the encoder finished"));

  // Both programs report their problems on stderr and then exit non-zero. The
  // exit is what ends the Track; the text is what makes the log worth reading.
  logStderr(extractor, (line) => log(`yt-dlp: ${line}`));
  logStderr(encoder, (line) => log(`ffmpeg: ${line}`));
  for (const [name, child] of [["yt-dlp", extractor], ["ffmpeg", encoder]] as const) {
    child.on("error", (cause) => {
      log(`could not run ${name} (${environment.extractorPath}/${environment.encoderPath}): ${String(cause)}`);
      finish(`${name} could not be run`);
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) log(`${name} exited with code ${code}`);
      // Only the encoder's exit ends the audio: the extractor finishes first by
      // design, and treating that as the end would truncate every Track by
      // whatever the encoder still had buffered.
      if (child === encoder) finish(`ffmpeg exited with code ${code}`);
    });
  }

  return { buffer, cancel: () => finish("the Set moved on") };
}

function logStderr(child: ChildProcess & { stderr: Readable }, log: (line: string) => void) {
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4_000);
    for (const line of tail.split("\n").slice(0, -1)) {
      if (line.trim()) log(line.trim());
    }
    tail = tail.slice(tail.lastIndexOf("\n") + 1);
  });
}

interface CollectedOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: boolean;
}

/** Runs a child to completion, capturing both streams and bounding the wait. */
function collect(child: ChildProcess & { stdout: Readable; stderr: Readable }, timeoutMs: number): Promise<CollectedOutput> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: CollectedOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms`, spawnError: false });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length > maxMetadataBytes) {
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Only the tail is ever read, and only to name which of two things went
      // wrong. Keeping all of it would let a chatty failure grow without bound.
      stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
    });
    child.on("error", () => settle({ code: null, stdout, stderr, spawnError: true }));
    child.on("close", (code) => settle({ code, stdout, stderr, spawnError: false }));
  });
}
