# Extractor fixtures

Example `yt-dlp` output, used by `test/track.test.ts` to pin the parsing of the
extractor's answers without running it.

Two kinds, kept apart on purpose:

- **`*.json`** — what `--dump-single-json` prints for a video, a live stream, a
  premiere and a playlist. Real multi-line captures in shape, so they stay as
  files and refresh with a plain redirect.
- **`extractorFailures.ts`** — what it prints to stderr when it gives up. Each
  is a single line beginning `ERROR:`, and a directory of one-line files like
  that reads like logs somebody committed by accident, so they are named
  constants instead. Its own comment carries the refresh instructions.

**Provenance, plainly:** none of this was captured from a live run — neither
`yt-dlp` nor `ffmpeg` is installed on the machine this was implemented on, so
nothing here is a transcript of a real invocation. The field names, the
`_type`/`live_status`/`availability` vocabulary and the `ERROR:` formats are
yt-dlp's own; the video ids and titles are invented. The JSON is reduced to the
fields the parser reads plus enough neighbours to prove it is not reading by
position.

Refresh the JSON against a real capture when you next have the binary to hand:

```sh
yt-dlp --dump-single-json --no-playlist '<url>' > video.json
```

A refreshed capture that breaks a test is the test doing its job — the parser
should be corrected, not the fixture trimmed to fit it.
