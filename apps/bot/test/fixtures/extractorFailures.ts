/**
 * What yt-dlp prints to stderr when it gives up, and which of the two things it
 * is blaming.
 *
 * A module rather than a directory of `.stderr.txt` files: each of these is one
 * line, and six one-line files whose contents begin with `ERROR:` read like
 * logs somebody committed by accident. The JSON fixtures next door stay as
 * files, because those really are multi-line captures and nothing mistakes a
 * `.json` for a log.
 *
 * **Provenance, plainly:** these were written against yt-dlp's documented
 * message formats rather than captured from a live run — neither `yt-dlp` nor
 * `ffmpeg` is installed on the machine this was implemented on, so nothing here
 * is a transcript of a real invocation. The `ERROR:` shapes are yt-dlp's own;
 * the video ids are invented.
 *
 * To refresh one against reality, run the extractor at a URL of that kind and
 * paste what it printed:
 *
 * ```sh
 * yt-dlp --dump-single-json --no-playlist '<url>' 2>&1 >/dev/null
 * ```
 *
 * A refreshed capture that breaks a test is the test doing its job — correct
 * the parser, do not trim the fixture to fit it.
 */

/** The video is the problem: nothing about the link or the extractor is wrong. */
export const unavailableVideo = {
  deleted:
    "ERROR: [youtube] G0n3F0r3v3r: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated.",
  private:
    "ERROR: [youtube] Pr1v4t3V1d: Private video. Sign in if you've been granted access to this video",
  geoBlocked:
    "ERROR: [youtube] Bl0ck3dH3r3: Video unavailable. The uploader has not made this video available in your country",
  ageRestricted:
    "ERROR: [youtube] aG3R35tR1cT: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies"
} as const;

/**
 * The source is refusing the extractor. The link is fine, so a member told to
 * find a different one would be looking for a problem that is not there.
 */
export const refusedExtractor = {
  botCheck:
    "ERROR: [youtube] aB3dE5gH7jK: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp  for how to manually pass cookies",
  tooManyRequests: [
    "WARNING: [youtube] Unable to download webpage: HTTP Error 429: Too Many Requests",
    "ERROR: [youtube] aB3dE5gH7jK: Unable to download API page: HTTP Error 429: Too Many Requests (caused by <HTTPError 429: Too Many Requests>)"
  ].join("\n")
} as const;
