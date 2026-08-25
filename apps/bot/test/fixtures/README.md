# Extractor fixtures

Example `yt-dlp` output, used by `test/track.test.ts` to pin the parsing of the
extractor's answers without running it.

Two kinds, kept apart on purpose:

- **`*.json`** — what `--dump-single-json` prints for a video, a live stream, a
  premiere, a playlist, and (in `search.json`) a flat listing for a search. Real
  multi-line captures in shape, so they stay as files and refresh with a plain
  redirect.
- **`extractorFailures.ts`** — what it prints to stderr when it gives up. Each
  is a single line beginning `ERROR:`, and a directory of one-line files like
  that reads like logs somebody committed by accident, so they are named
  constants instead. Its own comment carries the refresh instructions.

Since ticket 13 these stderr constants are read by two rules rather than one.
`classifyExtractorFailure` reads them for a link a member has just pasted, and
`classifyFetchFailure` reads them again for a Track whose turn came an hour
later — the same words asked the same question, which is why there is one list
of phrases and not two. `refusedExtractor.mediaRefused` is the only one of them
that a resolve can never produce: it is what the source says when the metadata
was fine and the media itself is refused.

ffmpeg has no fixtures here on purpose. Nothing reads its words — a failed
encode is judged by its exit code, because an encoder that refused audio the
extractor delivered is the bot's own trouble whatever it printed about it.

**Provenance, plainly:** none of this was captured from a live run — neither
`yt-dlp` nor `ffmpeg` is installed on the machine this was implemented on, so
nothing here is a transcript of a real invocation. That was true when ticket 11
was written and **it is still true after ticket 13**, which added two more
constants to `extractorFailures.ts` in exactly the same way: written to yt-dlp's
documented message formats, not observed. The field names, the
`_type`/`live_status`/`availability` vocabulary and the `ERROR:` formats are
yt-dlp's own; the video ids and titles are invented. The JSON is reduced to the
fields the parser reads plus enough neighbours to prove it is not reading by
position.

`search.json` deserves naming separately: **no query has ever been put to yt-dlp
from this repository at all**, so what a flat search listing contains — whether
every entry names a channel, whether `duration` is always there, how a live
result is marked — is documentation rather than evidence. It is the least
evidenced file here.

Refresh the JSON against a real capture when you next have the binary to hand:

```sh
yt-dlp --dump-single-json --no-playlist '<url>' > video.json
yt-dlp --dump-single-json --flat-playlist 'ytsearch5:<query>' > search.json
```

A refreshed capture that breaks a test is the test doing its job — the parser
should be corrected, not the fixture trimmed to fit it.
