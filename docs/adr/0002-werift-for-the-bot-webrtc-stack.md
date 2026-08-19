# werift for the bot's WebRTC stack

The bot sends the same audio to every listener in a room. `@roamhq/wrtc`, the better-
known native option, accepts only raw PCM, so libwebrtc runs **one Opus encoder per
peer connection** — twelve listeners would mean twelve encoders on twelve copies of
the same music, with no API to bypass it. It also ships no musl build, so it cannot
run on the project's `node:22-alpine` image without building libwebrtc from source.

We use **werift**, which has no codecs at all: it is an RTP pipe. ffmpeg encodes the
track to Opus once and the same encoded packets are written to every sender, so the
cost per extra listener is one SRTP encryption rather than a second encoder. It is
pure JavaScript with no native dependencies, which keeps the single-container,
no-build-step deployment intact.

`node-datachannel` is the fallback if JavaScript-side DTLS/SRTP ever becomes the
bottleneck — it has the same encode-once property with a native binary and musl
prebuilts.

## One qualification, from proving it

"The same encoded packets are written to every sender" means the same *bytes*,
not the same *object*. werift's sender rewrites the packet it is handed — ssrc,
payload type, sequence and timestamp offsets — and keeps that same object in its
retransmission cache, so handing one object to several senders leaves each cache
holding another listener's header. Each listener needs its own packet built from
the shared payload.

This costs an allocation per listener, not an encode, so the decision stands.
Measured in the headless-peer-audio spike, kept on the
`prototype/headless-peer-audio` branch; see its `spike/headless-peer-audio/FINDINGS.md`.
