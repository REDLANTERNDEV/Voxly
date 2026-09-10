# Voice Connection Reliability

## Goal

Make Voxly voice resilient to short packet-loss bursts, route changes, ICE
transitions, and Socket.IO reconnects without leaving members stuck on
`connecting` or forcing them to leave and rejoin manually.

The first implementation targets the current browser-to-browser WebRTC mesh
and the already deployed authenticated Coturn service. It does not introduce
an SFU, recording, server-side media processing, or a hosted media provider.

## Findings and deployment boundary

Coturn is active and the production application is reached through Cloudflare,
while the TURN hostname is DNS-only and bypasses the HTTP proxy. These are
different paths:

- Cloudflare and the reverse proxy carry HTTPS, Socket.IO signaling, and the
  application API.
- Coturn carries ICE relay traffic only when the browser selects a relay
  candidate.
- The existing connection indicator measures Socket.IO round-trip time outside
  a call, while voice quality is measured from inbound WebRTC audio stats.

A 170–200 ms application ping therefore does not prove that the media path has
the same RTT. The client must keep signaling RTT, selected media-path RTT,
candidate route, and audible decoder health as separate facts.

## Recommended approach

### 1. Make peer recovery an explicit state machine

Each peer will use the browser's ICE and peer connection states as separate
inputs:

- `connected`: media is established; no recovery work is scheduled.
- `disconnected`: start a short grace timer because browsers can recover this
  state without intervention.
- still `disconnected` after the grace window: request an ICE restart and send a
  fresh offer using the existing polite/impolite negotiation rules.
- `failed`: cancel the grace timer, close only the affected peer generation,
  and rebuild it with bounded backoff.

Recovery is single-flight per peer. It will not issue overlapping ICE restarts,
peer rebuilds, or offers. A bounded backoff prevents a bad route from causing
an offer storm, while an authoritative snapshot still cancels recovery when a
member leaves.

### 2. Make signaling generation-safe

Every peer instance will have a generation identity. ICE candidates, offers,
answers, track-ended callbacks, timers, and stats callbacks must verify that
they still belong to the current generation before mutating state. Candidates
queued for a closed generation will be discarded rather than applied to its
replacement.

The current shared offerer rule remains authoritative. The implementation will
preserve the audio transceiver invariant and the existing rollback behavior for
glare instead of adding a second negotiation policy in the web client.

### 3. Use quality evidence without overreacting

The existing decoder counters remain the primary audible-quality signal. Peer
recovery will distinguish:

- a brief loss or jitter sample that Opus/browser buffering can absorb;
- sustained decoder concealment or loss affecting one peer;
- an actual ICE/connection failure.

The first response to a sustained route problem is an ICE restart. Full peer
rebuild remains the fallback. A single degraded stats sample must never tear
down a healthy call.

Audio will continue using browser-managed Opus congestion control initially;
there will be no SDP munging or arbitrary bitrate cap without evidence that it
improves the measured voice path. Camera and screen adaptation remain isolated
from microphone recovery.

### 4. Report the right symptom to the member

The dock and voice surfaces will not treat Cloudflare/Socket.IO RTT as voice
RTT. Where a call is active, the media signal will be derived from live peer
stats and will name the symptom (`loss`, `jitter`, or connection recovery).
The UI will show `connecting` only during an actual bounded attempt; sustained
recovery will have a recoverable Turkish and English status rather than a
permanent spinner.

No raw TURN credential, session token, or sensitive signaling payload will be
logged or exposed in the UI. If diagnostic detail is needed, only safe values
such as candidate type, ICE state, RTT, loss, jitter-buffer behavior, and a
peer generation may be shown.

## Cloudflare and Coturn handling

The normal deployment topology remains:

```text
Browser -> Cloudflare/reverse proxy -> Voxly API + Socket.IO
Browser -> DNS-only TURN hostname -> Coturn
Browser <---------------------------> Browser media when direct ICE wins
```

The implementation will not proxy TURN through Cloudflare and will not force
relay for every call by default. For diagnosis, the selected candidate pair
will be available to tests/diagnostic inspection so a high Socket.IO RTT can be
compared with the actual media route. Coturn capacity, relay-port availability,
and geographic placement remain deployment concerns; the client cannot make a
far-away TURN server have local latency.

## Error handling and recovery boundaries

- A temporary `disconnected` state is silent and self-healing when it recovers
  inside the grace window.
- An ICE restart is retried with bounded backoff and is cancelled on leave,
  room change, socket generation change, peer replacement, or cleanup.
- A failed peer is rebuilt independently so one member's route problem does not
  tear down the whole room.
- Socket.IO disconnect recovery keeps the existing ten-minute resume window and
  acknowledged `voice:join` sequence.
- Camera and screen publishing remain off after a Socket.IO interruption unless
  the member explicitly starts them again, as required by the current media
  contract.
- Unsupported stats fields or `restartIce()` failures remain recoverable; the
  browser's native ICE behavior remains the fallback.

## Testing and validation

Focused tests will cover:

- the pure peer recovery state transitions and backoff/cancellation rules;
- disconnected grace handling versus failed-peer rebuild;
- stale generation callbacks and candidates being ignored;
- selected media RTT/candidate-type extraction without confusing it with
  Socket.IO RTT;
- existing glare, empty-audio-offer, resume, deafen, and visual-subscription
  behavior.

Validation will run in this order:

1. focused web tests;
2. web typecheck and build;
3. root typecheck and tests where the environment permits loopback sockets;
4. production smoke test with two devices on different networks, recording
   `chrome://webrtc-internals` ICE state, selected candidate types, RTT, and
   whether audio recovers without a manual rejoin.

Success means a short network transition does not leave audio permanently
silent or stuck on `connecting`, a sustained bad peer is repaired without
disturbing other peers, and the UI's reported quality corresponds to the media
path rather than only the Cloudflare signaling path.
