# ADR-0002 — werift for the bot's WebRTC stack

- **Status:** accepted
- **Date:** 2026-08-23
- **Context:** ticket 06, "The bot joins a voice channel and plays sound"

## Context

[ADR-0001](./0001-music-bot-is-a-mesh-peer.md) makes the Music bot a peer in the
mesh, which means a Node process needs a WebRTC implementation: DTLS, SRTP, ICE,
and an offer/answer exchange the browser client will accept.

Two things shape the choice. The bot sends **the same audio to every Listener**,
so whether the library lets that audio be encoded once is the difference between
a fixed cost and a cost per Listener. And Voxly ships as one small container
with no build step, so a native dependency without a musl prebuild would mean
compiling a media stack from source in the image.

## Decision

Use **werift** (0.24.4 at the time of writing), pinned to a caret range.

werift has no codecs at all — it is an RTP pipe. Audio is encoded to Opus once,
outside the library, and the same encoded packets are written to every sender.
The cost of one more Listener is one more SRTP encryption, not a second encoder.
It is pure JavaScript with no native dependencies, so the single-container,
no-build-step deployment stays intact.

## One qualification, from proving it

"The same encoded packets to every sender" means the same *bytes*, not the same
*object*. `RTCRtpSender.sendRtp` rewrites the packet it is handed — ssrc,
payload type, sequence number and timestamp — and keeps that same object in its
retransmission cache, so handing one object to several senders leaves each cache
holding another Listener's header. Measured directly: after one write to a track
shared by two peer connections, the caller's own object carried the second
sender's ssrc.

Each Listener therefore gets its own `MediaStreamTrack` and a fresh packet built
from the shared Opus payload. That costs an allocation per Listener, not an
encode, so the decision stands. `toRtpPacket` in `apps/bot/src/audio.ts` is where
it happens, and it carries a test that fails if the objects are ever shared
again.

Two smaller things worth knowing before reaching for the library's own helpers:

- `getUserMedia({ path })` from `werift/nonstandard` accepts only MP4 and WebM.
  The bundled Track is Ogg Opus, so the bot reads the Ogg pages and packetises
  itself. That is the shape the extractor path needs anyway, since ffmpeg hands
  over encoded Opus rather than a container.
- `createOffer` is asynchronous, and the peer's own offer can arrive during the
  await and move the connection out of `stable`. Applying the result then throws
  `InvalidStateError`, which — from a fire-and-forget call — is an unhandled
  rejection. Re-check the signalling state after every await.

## Alternatives considered

**`@roamhq/wrtc`**, the better-known native option. Rejected on the property
this decision turns on: it accepts only raw PCM, so libwebrtc runs **one Opus
encoder per peer connection**, with no API to bypass it. Twelve Listeners would
mean twelve encoders on twelve copies of the same music. It also ships no musl
build, so it cannot run on the project's Alpine image without building libwebrtc
from source.

**`node-datachannel`.** Has the same encode-once property, with a native binary
and musl prebuilts. Kept as the fallback if JavaScript-side DTLS and SRTP ever
become the bottleneck; not chosen now because a pure-JavaScript dependency is
worth more to this deployment than the headroom is.

**A headless browser.** Covered in ADR-0001: it works and is disproportionate.

## Consequences

- DTLS and SRTP run in JavaScript. Measured across a 48.7 s window in the ticket
  03 spike, a browser received 49.9 packets per second — the 50 pps of 20 ms
  Opus frames, exactly — with zero loss, zero concealed samples, and 0.002 s of
  jitter. There is no evidence of a problem at the room sizes a mesh supports,
  and `node-datachannel` is the answer if that ever changes.
- werift is the bot's dependency alone. Neither the server nor the browser
  imports it, so the choice can be revisited without touching either.
- The bot owns its own RTP framing and pacing, because the library deliberately
  does not. That is more code than a batteries-included stack would need, and it
  is code with tests rather than a library call with a comment.
- Everything the bot depends on is pure JavaScript, which is what let the spike's
  host `node_modules`, installed on macOS arm64, run unchanged inside a
  `node:24-alpine` container for the TURN measurement.

The evidence behind every number here is in `spike/headless-peer-audio/FINDINGS.md`
on the `prototype/headless-peer-audio` branch.
