/**
 * A link in, a Track out.
 *
 * This is the resolver half of the two roles the design keeps apart: it turns
 * what a member typed into the *identity* of a Track, and knows nothing about
 * how audio is fetched. `stream.ts` is the other half, and the seam between
 * them is what lets a second resolver — a search term, a link from somewhere
 * else — arrive later without touching the audio path. A resolver that could
 * not be turned into a YouTube video is not a resolver this bot can use, which
 * is why a Track's identity is a YouTube id rather than an opaque handle.
 *
 * Everything here is pure. The extractor's vocabulary is understood in exactly
 * one place, and it is a place a test can reach without a subprocess.
 */

import { musicTitleMaxLength, type MusicCommandAck } from "@voxly/shared";

/** A Track the bot can play: what to show, and what to fetch. */
export interface Track {
  id: string;
  title: string;
  durationSeconds: number;
  /** The canonical watch URL, rebuilt from the id rather than echoed back. */
  url: string;
}

type TrackError = Extract<MusicCommandAck, { ok: false }>["error"];

export type TrackResult = { ok: true; track: Track } | { ok: false; error: TrackError };

/** Eleven characters of base64url. YouTube has used this shape throughout. */
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;

/**
 * Hosts that serve a YouTube watch page. Matched exactly rather than by suffix:
 * `youtube.com.evil.example` ends in nothing of the sort, and a suffix test is
 * how that gets missed.
 */
const watchHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com"
]);
const shortHosts = new Set(["youtu.be", "www.youtu.be"]);

/** Paths that carry the video id in the path rather than in `v`. */
const idInPath = ["/shorts/", "/live/", "/embed/", "/v/"];

/**
 * The canonical watch URL for what a member pasted, or `null` if it is not one
 * video on YouTube.
 *
 * The URL is rebuilt from the id rather than passed through. A share link
 * arrives carrying a timestamp, a playlist and a tracking parameter; none of
 * them should reach the extractor, and dropping them means two people pasting
 * the same video from different places ask for exactly the same thing.
 */
export function youtubeVideoUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const id = videoIdIn(url);
  return id && videoIdPattern.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

function videoIdIn(url: URL): string | null {
  if (shortHosts.has(url.hostname)) {
    return url.pathname.slice(1) || null;
  }
  if (!watchHosts.has(url.hostname)) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const prefix = idInPath.find((candidate) => url.pathname.startsWith(candidate));
  return prefix ? url.pathname.slice(prefix.length) : null;
}

/**
 * `live_status` values that mean there is no finite Track behind the link. A
 * premiere is included: it has a duration and looks perfectly playable, and
 * there is nothing there to fetch until it airs.
 */
const notPlayableLiveStatus = new Set(["is_live", "is_upcoming", "post_live"]);

/**
 * The extractor's JSON, as a Track.
 *
 * Failure is a value rather than an exception because every one of these is an
 * answer a member is owed — a live stream and a playlist are different
 * sentences, and both are different from "the extractor broke".
 */
export function parseTrackMetadata(stdout: string): TrackResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "extractor_failed" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "extractor_failed" };
  const fields = raw as Record<string, unknown>;

  // A playlist URL that slipped past the link check, or one video's page that
  // the extractor decided was a playlist. Either way it is not one Track, and
  // quietly playing the first entry would be a playlist feature nobody asked
  // for — see the design's Out of Scope.
  if (fields._type === "playlist" || Array.isArray(fields.entries)) {
    return { ok: false, error: "unsupported_link" };
  }
  if (fields.is_live === true || notPlayableLiveStatus.has(String(fields.live_status))) {
    return { ok: false, error: "live_stream" };
  }

  const id = fields.id;
  const title = fields.title;
  const duration = fields.duration;
  if (typeof id !== "string" || !videoIdPattern.test(id)) return { ok: false, error: "extractor_failed" };
  if (typeof title !== "string" || title.trim().length === 0) return { ok: false, error: "extractor_failed" };
  // A missing duration is what a live stream has, and this one did not say it
  // was live. Zero is the same: there is nothing to start playing.
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "extractor_failed" };
  }

  return {
    ok: true,
    track: {
      id,
      // Somebody else's string, on its way to everyone in the room. Bounded
      // here, at the edge, rather than trusted the whole way in because it
      // happens to be short today.
      title: title.trim().slice(0, musicTitleMaxLength),
      durationSeconds: Math.round(duration),
      url: `https://www.youtube.com/watch?v=${id}`
    }
  };
}

/**
 * Phrases the extractor uses when the *video* is the problem rather than the
 * extractor. Matched on the source's own words, which is brittle by nature —
 * the alternative is telling everyone the same thing regardless, and the two
 * cases lead a member somewhere different: one to find another video, the other
 * to wait.
 *
 * Matching is deliberately narrow. Anything unrecognised falls through to
 * blaming the extractor, because "try again later" merely wastes time while
 * "your link is wrong" sends someone to fix what was never broken.
 */
const unavailablePhrases = [
  "video unavailable",
  "private video",
  "sign in to confirm your age",
  "this video is available to this channel's members",
  "members-only content",
  "video has been removed",
  "who has blocked it on copyright grounds",
  "not made this video available in your country"
];

/** Which of the two the extractor's own output blames. */
export function classifyExtractorFailure(stderr: string): "track_unavailable" | "extractor_failed" {
  const text = stderr.toLowerCase();
  return unavailablePhrases.some((phrase) => text.includes(phrase)) ? "track_unavailable" : "extractor_failed";
}
