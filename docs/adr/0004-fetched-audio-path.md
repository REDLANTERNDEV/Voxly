# ADR-0004 — How fetched audio reaches the mesh

- **Status:** accepted
- **Date:** 2026-08-23
- **Context:** ticket 07, "Paste a YouTube link and hear it"

## Context

Until now the bot played one file that shipped with it: read once at startup,
already Opus, already whole. A pasted link is none of those things. It has to be
fetched from somebody else's servers, decoded from whatever container they serve,
re-encoded to Opus, and framed as RTP — and it arrives over seconds rather than
all at once.

Three things had to be settled, and each of them is expensive to change later
because the player, the Queue and every failure message rest on them.

## Decision

### 1. yt-dlp and ffmpeg, spawned as subprocesses and piped together

`yt-dlp -o -` writes the source stream to stdout; `ffmpeg` reads that on stdin
and writes encoded audio to its stdout. Neither is an npm package, both are
pinned at image build time, and their paths are operator configuration
(`VOXLY_YTDLP_PATH`, `VOXLY_FFMPEG_PATH`) defaulting to bare command names on
PATH. No API key is required or used, by anyone, at any point.

Piping rather than downloading to a file is what keeps the container's read-only
filesystem intact, and it is also what makes playback able to start early.

Two roles stay separate, as the design requires. **Resolvers** turn what a member
typed into the identity of a Track — today one, `youtubeVideoUrl` plus
`parseTrackMetadata`. A single **audio provider** turns that identity into a
stream. A future Spotify link is a resolver that finds the named Track on
YouTube; it can never be an audio provider, because Spotify's terms do not permit
rebroadcasting its audio.

### 2. ffmpeg emits Ogg Opus, so there is one framing path

`-f opus` asks for the Ogg Opus muxer rather than a raw Opus stream. The bot then
reads Ogg pages and lifts the Opus packets out of them — exactly what it already
did for the file that used to ship with it.

The alternative was to ask ffmpeg for raw Opus and write a second framing path
beside the Ogg one. Rejected: lacing across the 255-byte boundary and across
pages are the two places this is easy to get subtly wrong, and the symptom of
getting either wrong is noise that sounds like a broken library. One path, one
set of tests, one place to be wrong. Ogg is a streaming container, so the pages
arrive incrementally and cost nothing.

The reader is therefore incremental: fed whatever the pipe happened to deliver,
it returns the packets that are now complete and holds back a partial page or a
packet whose last segment has not arrived.

### 3. Playback starts on a prebuffer and stalls on an underrun

Two seconds of audio (`prebufferFrames`) is held before the first note. Below
that the player waits.

The alternative was to buffer the whole Track before playing anything. Rejected
for what it costs the moment: a member who pastes a link waits out the entire
download before hearing anything, on every Track, and the wait grows with the
song. Once yt-dlp is actually running it delivers many times faster than
realtime, so what the prebuffer is really covering is the gap between its first
byte and its steady state.

**When the extractor is slower than the music, playback stalls.** The clock stops
where the audio ran out and resumes from that same frame when more arrives. The
alternatives were both worse:

- *Skip ahead to where the clock says playback should be.* The music silently
  loses whatever the extractor was late by, and nobody — not the listeners, not
  the log — ever learns which part of the Track they did not hear.
- *Keep the clock running and catch up.* The wait is owed back as a burst of
  frames the instant audio arrives, which the receiving jitter buffer discards
  as a flood. That is a longer gap than the stall, arrived at less honestly.

A stall does **not** report `speaking: false`. The bot is still playing this
Track; flickering every Listener's indicator off and on for half a second of
buffering would report a state nobody is in. What a stall does do is re-arm the
marker bit, because audio resuming after silence is a new talkspurt and the
receiving jitter buffer has nothing else to resynchronise on.

## Consequences

- **Ongoing maintenance is part of the feature.** yt-dlp breaks when YouTube
  changes, and fixes arrive in its nightly releases within days. Expect the music
  to stop working a few times a year until the operator redeploys. The upstream
  client it presents is configurable (`VOXLY_YTDLP_CLIENT`) so an operator can
  react without rebuilding. This is an accepted cost, not a defect, and the
  operator documentation says so.
- **Deployment now has two binaries to carry**, pinned at build time. Ticket 14
  owns that; see the notes at the end of it.
- A Track ends now, where the bundled one looped. The player reports the end and
  says nothing about what follows — that is the Queue's decision, and ticket 08's.
- One RTP stream spans a whole Set rather than a Track. Sequence numbers and
  timestamps advance monotonically across a Track change; only the marker bit
  and the position within the Track reset. Restarting the numbering per Track
  would look to a receiver like a flood of very old packets arriving out of order.
- The bundled `chime.opus` retires from the product path. It stays as a test
  fixture, because a hand-built Ogg page is not evidence that a real encoder's
  output parses.
- Nothing about the encode-once property of [ADR-0002](./0002-werift-for-the-bot-webrtc-stack.md)
  changes. ffmpeg encodes once per Track, not once per Listener, and the packets
  it produces are still shared by every Listener's sender.

## What is not settled here

Whether a Track that fails *mid-playback* is skipped, retried, or reported is
ticket 13's. This ADR settles only that the audio ends where the stream ended,
which is what a player already sending frames needs.
