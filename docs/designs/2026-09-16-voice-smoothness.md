# Voice Smoothness and Recovery Design

**Status:** approved for implementation planning

## Goal

Give members a clean, low-friction voice experience without requiring them to
understand WebRTC, ICE, TURN, packet loss, or peer-to-peer recovery. Short-lived
audio problems should recover automatically, and microphone testing should not
introduce an audible background artifact.

The browser-to-browser P2P mesh remains the media architecture. This design does
not introduce an SFU, recording, server-side audio processing, or a hosted media
provider.

## Evidence from the current implementation

The current web suite passes 666 tests, and repository type-checking and builds
are clean. The reported behavior is therefore not covered by the existing
deterministic tests and needs browser-lifecycle and live-media coverage.

Two symptoms are distinct:

1. The microphone test frequently produces a light, non-metallic crackle or
   background sound even when Voxly's extra noise filter is disabled. This path
   is local: `getUserMedia` capture, the microphone Web Audio graph, the monitor
   destination, and the native audio output. It does not require a remote peer.
2. During a call, severe robot-like, crackling audio coincides with the dock's
   `breaking` state. The existing inbound WebRTC stats grader already reports
   this state from packet loss or decoder concealment. The current recovery
   lifecycle handles ICE disconnection/failure but does not automatically
   recover a peer that remains ICE-connected while its audio quality is
   breaking.

The first symptom must be isolated against the capture pipeline before changing
browser processing flags. The second symptom is consistent with a degraded P2P
media path, but it is not evidence that the topology must change: the affected
peer can be measured and recovered independently.

## Design

### 1. Keep the local microphone path single-owner and deterministic

The active voice microphone graph remains the source of the monitor stream while
the member is in a voice room. The microphone test must not keep a second
capture graph open for the same device during a voice transition. When the test
is active before joining, the join action stops the independent microphone test
before opening voice capture. The voice join then owns the only live capture
graph, and the test's graph is disposed exactly once.

The existing browser-native capture requests remain unchanged initially:
`noiseSuppression`, `autoGainControl`, and `echoCancellation` stay requested as
plain booleans. Voxly's additional filter remains opt-in. A diagnostic
regression test will prove that the disabled path is not accidentally processed
by the optional spectral stage.

The AudioWorklet must receive its initial enabled state at construction time,
not only through an asynchronous message after it is connected. This prevents
the disabled preference from briefly running the spectral path during worklet
startup. The worklet remains available for explicit opt-in and its bypass path
must remain transparent.

### 2. Recover audio quality per peer without user action

The existing `VoiceQuality` sampling remains based on inbound RTP decoder
counters and selected media transport stats. Sampling will retain the identity
of each peer long enough for recovery decisions to target the affected
connection rather than rebuilding the whole room.

Recovery is coordinated by the existing `useVoiceMedia` peer lifecycle:

- a clear sample resets the degraded streak for that peer;
- one degraded sample is observational and does not interrupt audio;
- two consecutive degraded samples for the same peer request recovery;
- the existing deterministic offerer sends the ICE restart request/offer;
- if restart does not restore the peer within the existing bounded timeout, the
  existing generation-safe rebuild path replaces only that peer;
- recovery state is single-flight and cooldown-limited;
- authoritative member removal, leave, room change, socket disconnect, and
  peer replacement cancel stale recovery work.

The quality sampler must not directly close or replace peer connections while it
is iterating stats. It reports a bounded recovery request to the media owner,
which already owns timers, generations, signaling, and cleanup. This preserves
the reason the previous recovery side effect was removed from the sampler while
restoring the missing behavior for a connected-but-breaking media path.

The UI keeps the current quality signal. It may show reconnecting only during a
real bounded attempt; members should not be asked to leave and rejoin. If the
network remains materially unusable after bounded recovery, the existing
recoverable failure state remains the fallback.

### 3. Preserve P2P and avoid speculative codec changes

No SFU or server media relay is introduced. No SDP munging, arbitrary bitrate
cap, or codec switch is added without measured evidence that the current media
path needs it. The first response to a breaking peer is targeted ICE recovery,
because the current stats already identify the path as degraded and the
application already has a generation-safe recovery mechanism.

If browser smoke testing shows that recovery cannot make a materially bad path
usable, the result will be documented as an environmental P2P limitation rather
than hidden behind a misleading UI. That would be a follow-up architecture
discussion, not part of this fix.

## Failure and cleanup behavior

- A single bad sample never tears down a healthy peer.
- A repeated bad sample cannot start overlapping restart/rebuild work.
- Recovery is scoped to one peer and cannot disturb other participants.
- Late stats, timers, worklet promises, and signaling callbacks are ignored
  when their generation is no longer current.
- A microphone graph, raw capture stream, generated voice track, monitor track,
  and audio context are disposed exactly once.
- If optional AudioWorklet setup fails, the existing recoverable expander path
  continues to carry audio.
- If native audio processing is the remaining source of the light monitor
  artifact, the implementation will expose that distinction in tests and
  diagnostics rather than silently claiming Voxly's optional filter fixed it.

## Testing and validation

### Automated tests

Add focused web tests before implementation for:

- optional worklet construction starting disabled and bypassing audio without a
  startup processing window;
- joining voice while the microphone test is active stops the test before voice
  capture opens, keeping one active graph and disposing the test graph once;
- per-peer quality recovery requiring two degraded samples;
- a clear sample resetting the degraded streak;
- cooldown and single-flight preventing repeated recovery storms;
- quality recovery targeting only the affected peer;
- stale recovery callbacks being ignored after peer replacement or member leave.

Run the focused tests red, implement the smallest change, then run them green.
Run the complete web suite, workspace type-check, build, `git diff --check`, and
inspect the final working-tree scope.

### Browser smoke test

With two members in one voice room:

1. Start the microphone test with the optional Voxly filter disabled and listen
   for the light background artifact.
2. Join voice from the same surface and confirm the test and voice capture do
   not overlap audibly.
3. Join the room from two fresh browser sessions and confirm both hear clean
   audio without leaving and rejoining.
4. During a call, introduce a brief network change or packet-loss event and
   confirm the affected peer recovers without the user leaving the room.
5. Confirm the dock's `breaking` state corresponds to live media stats and
   clears after recovery, while other peers remain connected.

The smoke test must also record whether the selected media route is direct or
relay and whether the artifact occurs in local monitor audio, remote received
audio, or both. This distinction determines whether any remaining issue is an
application bug or an external device/network limitation.

## Scope boundaries

Included: local monitor lifecycle, optional worklet initialization, connected
peer quality recovery, generation-safe cleanup, regression tests, and operator
safe browser validation.

Excluded: SFU adoption, server-side mixing, recording, hosted media providers,
unmeasured SDP/codec tuning, and unrelated UI or deployment refactors.
