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

import {
  musicSearchResultsMax,
  musicTitleMaxLength,
  type MusicCommandAck,
  type MusicSearchResult,
  type MusicTrackFailure,
  type MusicTrackSummary
} from "@voxly/shared";

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

/**
 * What a search offered, or why it could not be read. Empty is a success: a
 * name that matched nothing is an answer rather than a refusal, and there is
 * nothing about it for a member to wait out.
 */
export type SearchResult = { ok: true; results: MusicSearchResult[] } | { ok: false; error: TrackError };

/**
 * Which resolver a member's input belongs to.
 *
 * `unsupported` is a link this bot cannot play — a playlist, a channel, another
 * site — and not "that was not a link", which is now an ordinary thing to type.
 * `nothing` is an input with no characters in it, which is neither.
 */
export type ResolverChoice =
  | { kind: "link"; url: string }
  | { kind: "search"; name: string }
  | { kind: "unsupported" }
  | { kind: "nothing" };

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
  return id && videoIdPattern.test(id) ? watchUrlFor(id) : null;
}

/**
 * The one place a watch URL is spelled out. Every link this module hands on —
 * for a pasted one, for a Result — is built here from a validated id rather
 * than echoed from what arrived.
 */
function watchUrlFor(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
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
 * A string that announces itself as a web address. This is the whole test for
 * "did somebody paste a link", and it is deliberately not a test for "is this
 * playable" — that is `youtubeVideoUrl`, one line further down.
 *
 * `https?` and nothing else, because a colon on its own is not evidence of
 * anything: "Beethoven: Symphony No. 5" is a name somebody typed, and a scheme
 * test loose enough to accept `javascript:` accepts that too.
 */
const webLinkPattern = /^https?:\/\//i;

/**
 * Which of the two resolvers a member's input is for.
 *
 * **The bot decides this, and nothing else does.** A browser that split "play
 * this link" from "search for this" would be holding a second opinion about
 * what a link is worth, which is the copy that drifts — refusing a form this
 * process has since learned to accept, with nobody able to say why. So one
 * field carries both and the answer says which happened. ADR-0007.
 *
 * A pasted link brings its scheme; a typed host does not, so `https://` is
 * tried in front of one — through the same exact-host check, so nothing new is
 * recognised, only the same links written shorter. Anything that still is not
 * one video on YouTube is a name, unless it announced itself as a web address,
 * in which case the member wants to hear that their link is wrong rather than
 * to be shown search results for its text.
 */
export function resolverFor(input: string): ResolverChoice {
  const trimmed = input.trim();
  // Neither a link nor a name. The panel will not send this, but the server's
  // bound is applied before trimming, so a field of spaces does reach here —
  // and it is not `unsupported`, which means "your link is wrong" and would be
  // the wrong sentence to put in front of somebody who typed no link at all.
  if (!trimmed) return { kind: "nothing" };

  const pasted = youtubeVideoUrl(trimmed);
  if (pasted) return { kind: "link", url: pasted };
  if (webLinkPattern.test(trimmed)) return { kind: "unsupported" };

  const typed = youtubeVideoUrl(`https://${trimmed}`);
  // A name is one line whatever it arrived as. A paste out of a tracklist can
  // carry a newline and a run of spaces with it, and the source is being asked
  // about the words rather than about the spacing between them.
  return typed ? { kind: "link", url: typed } : { kind: "search", name: trimmed.replace(/\s+/g, " ") };
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
  if (isBroadcast(fields)) return { ok: false, error: "live_stream" };

  const named = playableVideo(fields);
  if (!named) return { ok: false, error: "extractor_failed" };

  return { ok: true, track: { ...named, url: watchUrlFor(named.id) } };
}

/**
 * The three fields that make an entry a Track, read the same way whether they
 * came from one video's page or from a line of a search listing. `null` when
 * any of them is missing or nonsense — the two callers turn that into their own
 * kind of answer, which is the only thing they differ on.
 *
 * A missing duration is what a live stream has, and an entry reaching here did
 * not say it was live. Zero is the same: there is nothing to start playing.
 *
 * The title is bounded here, at the edge, rather than trusted the whole way in
 * because it happens to be short today: it is somebody else's string on its way
 * to everyone in the room.
 */
function playableVideo(fields: Record<string, unknown>): MusicTrackSummary | null {
  const { id, title, duration } = fields;
  if (typeof id !== "string" || !videoIdPattern.test(id)) return null;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    id,
    title: title.trim().slice(0, musicTitleMaxLength),
    durationSeconds: Math.round(duration)
  };
}

/** What the extractor says when there is no finite Track behind an entry. */
function isBroadcast(fields: Record<string, unknown>): boolean {
  return fields.is_live === true || notPlayableLiveStatus.has(String(fields.live_status));
}

/**
 * The extractor's answer to a search, as a list of Results.
 *
 * The flat listing the search asks for is one request rather than one per
 * result, so each entry carries what the listing knew and no more: an id, a
 * title, a length and a channel. That is enough to choose between them, which
 * is all this list is for — the Track itself is resolved properly when the
 * member picks one, through exactly the path a pasted link takes.
 *
 * An entry that cannot be read is skipped rather than failing the search: the
 * other four are still answers, and one odd row in somebody else's listing is
 * not a reason to tell a member their search broke.
 */
export function parseSearchResults(stdout: string): SearchResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "extractor_failed" };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "extractor_failed" };
  const entries = (raw as Record<string, unknown>).entries;
  // No `entries` at all is not an empty search — it is output of a shape this
  // does not understand, and calling that "nothing matched" would tell a member
  // to try another name for a fault that has nothing to do with their name.
  if (!Array.isArray(entries)) return { ok: false, error: "extractor_failed" };

  const results: MusicSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (results.length >= musicSearchResultsMax) break;
    const result = searchResultFrom(entry);
    // The same video twice is a choice that is not a choice, and it costs a row
    // that could have shown a different one.
    if (!result || seen.has(result.track.id)) continue;
    seen.add(result.track.id);
    results.push(result);
  }
  return { ok: true, results };
}

/** One entry of the listing, or `null` if it is not a Track a member could pick. */
function searchResultFrom(entry: unknown): MusicSearchResult | null {
  if (typeof entry !== "object" || entry === null) return null;
  const fields = entry as Record<string, unknown>;

  // Offering these would be offering a refusal: a live stream has no end and a
  // premiere has not happened, and the bot knows both before the member clicks.
  if (isBroadcast(fields)) return null;

  const track = playableVideo(fields);
  if (!track) return null;
  return {
    track,
    channel: channelName(fields),
    // Rebuilt from the id, never echoed from the listing. The browser hands
    // this straight back to play it, so it has to be a link this process built.
    url: watchUrlFor(track.id)
  };
}

/**
 * Who published it — the one thing that tells a cover from the original. The
 * source names it two ways and a flat listing may name it neither, in which
 * case the Track is still perfectly playable and the panel simply has one line
 * fewer to draw.
 */
function channelName(fields: Record<string, unknown>): string {
  const named = [fields.channel, fields.uploader].find((value) => typeof value === "string" && value.trim());
  return typeof named === "string" ? named.trim().slice(0, musicTitleMaxLength) : "";
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

/**
 * What a fetch had to say for itself when it stopped.
 *
 * Everything the two processes told `stream.ts`, as plain values, so that the
 * decision below can be asserted without either binary being installed. The
 * exit codes are `null` where the process was signalled or has not been reaped
 * yet — which is ordinary here rather than exceptional, because the encoder's
 * exit is what ends a fetch and the extractor's own may land a tick later.
 */
export interface TrackFetchOutcome {
  /** The Set moved on — a skip, a removal, the next Track, the Set ending. */
  cancelled: boolean;
  /** One of the two programs could not be run at all. */
  spawnFailed: boolean;
  /** The whole fetch ran out of time and was abandoned. */
  timedOut: boolean;
  /** yt-dlp's stderr, as much of the tail as was kept. */
  extractorStderr: string;
  extractorCode: number | null;
  encoderCode: number | null;
  /** The Ogg stream stopped mid-page or mid-packet. */
  incomplete: boolean;
  /**
   * No playable audio ever arrived, so the room heard none of this Track.
   *
   * The one signal here that cannot race. `finish()` runs on the encoder's
   * exit, and both the extractor's exit code and the tail of its stderr may
   * still be in flight at that moment — a fetch that produced nothing and can
   * prove nothing about why would otherwise be indistinguishable from a Track
   * that played out, which is the exact bug this ticket exists to fix.
   */
  silent: boolean;
}

/**
 * yt-dlp saying it gave up, in the one shape it says it in.
 *
 * Read as well as the exit code rather than instead of it, because the two
 * arrive at different moments: `finish()` runs on the *encoder's* exit, and the
 * extractor's own may not have been delivered yet. Its `ERROR:` line has been —
 * stderr is data on a stream the process wrote before it left.
 */
const extractorGaveUp = /^ERROR:/m;

/**
 * Why a Track whose turn came would not play, or `null` because it did.
 *
 * This is the ticket-13 counterpart to `classifyExtractorFailure`, and it
 * deliberately *calls* that rather than repeating it: whether the source's
 * words blame the video or the source is one question with one answer, whether
 * it is asked before the bot joins or an hour later when the Track reaches the
 * head of the Queue. What is new here is the third answer, which the resolve
 * path cannot produce — a fetch spawns ffmpeg, and a missing encoder is neither
 * a blocked video nor a source refusing anything.
 *
 * The order of the questions is the order of certainty. A cancel explains every
 * other signal on the outcome and so is asked first; the bot's own failures are
 * facts rather than readings; and only then is somebody else's stderr matched
 * against a list of phrases. Anything unrecognised comes out as the source's
 * fault, which is the same safe direction `classifyExtractorFailure` takes for
 * the same reason: "that video will not play" sends a room to replace a Track
 * that was never broken.
 */
export function classifyFetchFailure(outcome: TrackFetchOutcome): MusicTrackFailure | null {
  // Not a failure at all. The Set moved past this Track, and both programs were
  // killed mid-sentence — so the exit codes, the truncated stream and anything
  // on stderr are what being cancelled looks like, not evidence of anything.
  if (outcome.cancelled) return null;
  // A binary that could not be run is a deployment fault. It cannot be the
  // video, and telling the room to wait for the source to recover would be a
  // wait that never ends.
  if (outcome.spawnFailed) return "failedBot";
  // Which side stalled is not knowable from here, and thirty minutes of neither
  // program finishing is not a sentence about YouTube.
  if (outcome.timedOut) return "failedBot";
  if (extractorGaveUp.test(outcome.extractorStderr) || failedExit(outcome.extractorCode)) {
    return classifyExtractorFailure(outcome.extractorStderr) === "track_unavailable"
      ? "failedUnavailable"
      : "failedSource";
  }
  // The extractor delivered and the encode did not survive it, or survived it
  // and left the stream mid-packet. Either way the source did its part.
  if (failedExit(outcome.encoderCode) || outcome.incomplete) return "failedBot";
  // Nothing at all came out and nothing here says why. Not the source's fault
  // by default: "YouTube is refusing us" is a sentence that sends a room to
  // wait, and this is a sentence that should send somebody to the bot's logs,
  // where the reason this could not name will be written down.
  if (outcome.silent) return "failedBot";
  return null;
}

/** A process that ran and refused. `null` is one that was signalled or is late. */
function failedExit(code: number | null): boolean {
  return code !== null && code !== 0;
}
