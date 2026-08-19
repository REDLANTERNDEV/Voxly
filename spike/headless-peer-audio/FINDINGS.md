# Findings

Date: 2026-08-19. Everything below was measured, not reasoned about.

## The answer

**Yes.** A headless Node peer authenticates as an ordinary member, joins a Voxly
voice room through the ordinary HTTP and Socket.IO surface, and Chrome decodes
its audio cleanly. [ADR-0002](../../docs/adr/0002-werift-for-the-bot-webrtc-stack.md)
holds. Nothing here changes the architecture.

Chrome, receiving the bundled Track from the bot over a direct connection,
across a continuous 48.7 s window:

| Measure | Value |
| --- | --- |
| Packets received | 49.9 per second — the 50 pps of 20 ms Opus frames, exactly |
| Packets lost | 0 |
| Concealed samples | 0 — the jitter buffer never had to invent audio |
| Jitter | 0.002 s |
| Codec | `audio/opus` payload type 111, `minptime=10;useinbandfec=1` |
| Audio energy | Accumulating steadily; instantaneous level moving 0.30–0.64 |
| Playback | An unmuted, playing `<audio>` element with a live track |

Zero loss *and* zero concealment together are the interesting part: it is not
that the audio arrived and was patched up, it is that nothing needed patching.

**How that measurement was taken, because it matters.** The browser could not
open a microphone — the sandbox blocks capture — so it joined the AFK room,
which is the one room the client joins with the microphone off. That should have
run into finding 1 below. It did not, and only because the bot's account was
chosen so that its user id sorted *below* the browser's: with the ids that way
round `shouldInitiatePeerConnection` tells the browser not to offer, so it only
ever answered, and a `recvonly` answer to the bot's `sendrecv` offer is
perfectly well-formed. Bot accounts were created until one sorted low enough.

That is not a trick to make the numbers look good — it is the ordinary path for
half of all Listeners, and it is the path the Music bot will use. But it means
the browser measurement above covers the case where the bot offers first, and
says nothing about the case where the Listener does. That case is finding 1, and
it is broken.

## Versions

| | |
| --- | --- |
| werift | 0.24.4 |
| Node | 24.13.0 (host), 24-alpine (container) |
| Chrome | the Claude Code Browser pane's Chromium |
| coturn | 4.14.0-r0 |
| socket.io-client | 4.8.1 |
| opusscript | 0.1.1 — spike only, for decoding on the receiving side |

## What was verified, and what was not

| Criterion | Status |
| --- | --- |
| A browser decodes the bot's audio, direct connection | **Verified**, for the case where the bot offers first — see the caveat above |
| Traffic forced through TURN | **Verified** between headless peers; a browser over TURN was not — see below |
| Two Listeners hearing it at once | **Verified** with two *headless* Listeners, which sidestep finding 1 — see below |
| A person confirms it sounds clear | **Not verified — this still needs a human** |
| Two *browser* Listeners at once | **Not verified** |

The gaps come from three limits of this session: no ears, one browser profile,
and a sandbox that blocks microphone capture.

The two-Listener row deserves its own warning. Both Listeners were this spike's
own headless peers, and this spike always offers rather than following
`shouldInitiatePeerConnection` (see finding 1). So it proves that one encoded
Track fans out to two Listeners at once — which is the thing ADR-0002 is
betting on — but it deliberately avoids the negotiation path that finding 1
says is broken. Two *browser* Listeners is still an open question, and half of
them would hit finding 1 today.

### The TURN leg

With `iceTransportPolicy: "relay"` on every peer — so a connection can only
form through TURN — and a real coturn issuing credentials from Voxly's own
`/api/rtc/config`:

```
listener 1 from 57f4e66b: 390 packets  81 KiB  7.8s decoded  0 lost  peak -2.8 dBFS  rms -14.5 dBFS
listener 2 from 57f4e66b: 390 packets  81 KiB  7.8s decoded  0 lost  peak -2.8 dBFS  rms -14.5 dBFS
```

coturn's log confirms it did the relaying, with the credentials Voxly generated:

```
session 005000000000000001: new, realm=<turn>, username=<1787225927:57f4e66b-…>, lifetime=600
session 005000000000000001: … incoming packet ALLOCATE processed, success
```

The decoded peak and RMS are identical to the source WAV's, so the audio came
through the relay bit-for-bit as far as the ear can tell.

What is not covered: a *browser* Listener over TURN. Docker Desktop for Mac
cannot host a TURN server the host can relay through — see the README — so the
browser and the TURN server could not be put on the same footing. Worth
re-running on the real deployment, where both are ordinary network peers.

## Things worth knowing before building ticket 06

### 1. A browser Listener with no microphone cannot be reached — half the time

The largest finding, and it is a defect in the current client rather than
anything to do with the bot.

`syncLocalTracks` only adds tracks that exist. A member who joins with the
microphone off has none, so `createOffer` produces SDP with **no media sections
at all**. That connection can never carry anything.

It only bites when that member is the one who offers, which
`shouldInitiatePeerConnection` decides by string-comparing the two user ids. So
it is a coin flip per pair: a mic-less Listener whose id sorts below the bot's
sends the broken offer and deadlocks; one whose id sorts above never offers,
answers `recvonly`, and works perfectly. Both halves were observed in this
session, against the same browser, minutes apart, with nothing different but
which account the bot was using.

That is almost certainly why nobody has noticed. What happens in the broken
half:

1. The empty offer goes out. Chrome's connection stays `new` forever.
2. The answer to a zero-m-line offer is not something Chrome will apply; the
   offerer stays in `have-local-offer`.
3. Every later offer — including the bot's, which does carry audio — collides
   with that stuck local offer. If the stuck peer is the impolite one,
   `shouldIgnoreIncomingOffer` drops it. The pair deadlocks.
4. The recovery path tears the peer down and rebuilds it, which produces
   another empty offer. It loops.

Observed directly. With the bot's id above the browser's:

```
<- offer 0 m-line(s) [] from 106fdb1c      the browser, joined with no microphone
-> answer 0 m-line(s) [] to 106fdb1c
peer 106fdb1c failed
-> offer 1 m-line(s) [sendrecv] to 106fdb1c   ignored; the browser is stuck and impolite
```

The browser sat in `have-local-offer` and cycled through three peer connections.
With the bot's id *below* the browser's, the same browser in the same room:

```
-> offer 1 m-line(s) [sendrecv] to 106fdb1c
<- answer 1 m-line(s) [recvonly] from 106fdb1c
peer 106fdb1c connected
```

985 packets, nothing lost, nothing concealed.

Today the broken half is invisible: the only room that joins with the microphone
off is AFK, where nobody has anything to send, so a mesh of silent broken
connections looks exactly like a mesh of silent working ones. The Music bot makes
it visible and breaking, because a Listener who muted before summoning the bot
would hear nothing — and their friend next to them, on the other side of the
coin flip, would hear it fine.

This is not a Chrome quirk. werift produces the same thing — `createOffer` on a
connection with no transceivers gives an SDP with a session block and nothing
else — so any spec-compliant implementation will. The test fixture in
`test/mesh.test.ts` is generated that way rather than hand-written, precisely so
the fixture cannot drift away from what a real client sends.

**The fix belongs in the web client, not the bot**: add a `recvonly` audio
transceiver when there is no microphone track, so an offer always has a media
section. This should be part of ticket 06, or a ticket of its own before it.

The bot works around the other half by **always offering**, rather than only
when the user-id tie-break says to. That is a real difference from
`shouldInitiatePeerConnection` and it is deliberate — see `mesh.ts`.

That workaround has a trap in it, which this spike fell into and which ticket 06
will meet too. The obvious way to write "offer to everyone in the room" is to
offer when the snapshot shows a member you have no peer for. But a signal from
that member often beats the snapshot through the server, so the peer already
exists by the time the snapshot lands, and the offer is skipped — leaving
exactly the silence the rule was written to prevent. It has to key on *having
offered*, not on the peer being new. `test/mesh.test.ts` holds that line.

### 2. An owner's mute does not stop the music

The bot was tested in the AFK room. The server marked it muted, the member list
showed it as muted, and Chrome played its audio throughout.

This is correct behaviour for a peer-to-peer mesh — the server never touches
media, so it cannot silence anything — but it means story 30 ("mute the Music
bot the same way I mute anyone") is **not** free. The bot has to watch its own
`moderation.muted` in the voice snapshot and stop writing packets itself. Server
enforcement is advisory here.

Same applies to the AFK room's forced mute: the bot must refuse to play there,
or honour it, rather than assuming the server will.

### 3. werift rewrites the packet you hand it

`RTCRtpSender.sendRtp` mutates the `RtpPacket` in place — ssrc, payload type,
and it adds its own sequence and timestamp offsets — and then keeps that same
object in its retransmission cache. Measured directly: after writing one packet
to a track shared by two peer connections, the *caller's* object carried the
second sender's ssrc.

So "write the same encoded packets to every sender" needs one qualification: the
same *bytes*, not the same *object*. This spike gives each Listener its own
`MediaStreamTrack` and builds a fresh packet per Listener from the shared Opus
payload. The expensive part — encoding — still happens once, which is the
property ADR-0002 was actually buying. The per-Listener cost is a small
allocation plus the SRTP encryption that was always going to be there.

Worth a sentence in ADR-0002; it does not change the decision.

### 4. Re-check the signalling state after `await createOffer()`

`sendOffer` guarded on `signalingState === "stable"` before awaiting
`createOffer`, and then applied the result. In between, the peer's own offer
arrived and moved the connection to `have-remote-offer`, so
`setLocalDescription` threw `InvalidStateError` and — being an unhandled
rejection from a fire-and-forget call — took the process down.

The browser client already re-checks after the await, via its offer-generation
counter. Anything written against werift needs the same care. The bot process
should also never die from one peer's failed negotiation.

### 5. werift's own file player will not help

`getUserMedia({ path })` from `werift/nonstandard` accepts only MP4 and WebM.
The bundled Track is Ogg Opus, so this spike reads the Ogg pages and packetises
itself — about forty lines, and the shape the real bot needs anyway, since
ffmpeg will hand it encoded Opus rather than a container. Lacing across the
255-byte boundary and across pages both matter and are covered by tests; getting
either wrong yields noise that is easy to misdiagnose as "the library does not
work".

### 6. Everything is pure JavaScript, and that keeps paying

werift, socket.io-client and opusscript are all pure JS. The host's
`node_modules`, installed on macOS arm64, ran unchanged inside `node:24-alpine`
for the TURN test. The single-container, no-build-step deployment ADR-0002 was
protecting is intact.

## Surprises that were not problems

- Opus channel mismatch is a non-issue. The Track is mono, the SDP says
  `opus/48000/2`, and Chrome decoded it without complaint.
- The public STUN default (`stun.l.google.com`) is contacted on every peer
  connection when no TURN is configured. Expected, but worth remembering when
  reading traces.
- 20 ms pacing needs to catch up against a clock, not `setInterval(20)`. This
  spike ticks at 5 ms and sends whatever is due; the browser measured 49.9 pps
  over 48 seconds, so the drift correction works.

## What is not merged

All of it. This directory is evidence, not a starting point. `mesh.ts` is the
closest thing to reusable, and even that should be rewritten against ticket 04's
shared negotiation rules rather than copied.
