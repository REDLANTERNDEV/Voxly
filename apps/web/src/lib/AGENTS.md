# Web Library and Media Instructions

These instructions apply to browser helpers under `apps/web/src/lib` and add
detail to `apps/web/AGENTS.md` and the repository root instructions.

## Module Design

- Prefer deterministic pure helpers for transitions, selectors, parsing,
  clamping, and request state. Keep browser side effects in explicit lifecycle
  adapters.
- Keep cleanup idempotent. A stale callback, acknowledgement, timer, track
  event, or peer event must not mutate a replacement generation.
- Treat unsupported browser optimizations as recoverable unless the underlying
  feature cannot safely continue.
- Preserve typed boundaries through `api.ts`, `socket.ts`, and
  `@voxly/shared`; do not create untyped parallel event shapes.

## Atomic Voice Membership

- All explicit joins, room moves, LIVE joins, and reconnects use the
  acknowledged `voice:join` request. Do not restore the old string-only join or
  a join-then-correct-media sequence.
- Compute effective media from observable tracks:
  - `mic` is true only when mic control is on, deafen is off, and an audio track
    is both `enabled` and `live`.
  - `camera` and `screen` are true only when their controls are on and the
    corresponding video track is `live`.
  - `deafened` comes from the local control.
  - `speaking` starts false and changes only through voice activity.
- The server ACK is authoritative. Reconcile local controls with the returned
  `VoiceMemberState`; do not report a join as complete on timeout or rejection.
- Voice-join and visual-subscription requests use deterministic five-second
  timeouts and settle once even if a late ACK arrives.
- Receive-only joins must not request microphone permission. Intentional normal
  and LIVE joins may start mic-on only after a live enabled track is ready.

## Reconnect and Recovery

- Keep the voice resume window at ten minutes from the first disconnect. Saving
  state again must not extend that original deadline.
- Recovery is single-flight and ordered: acknowledged join, snapshot refresh,
  then acknowledged visual-subscription restoration.
- Retry failed or timed-out recovery after two seconds while connected and
  before the deadline. Repeated Socket.IO connect events may trigger immediate
  work but must not create parallel attempts or timers.
- Preserve selected visual targets while retrying. Mark recovery complete only
  after join and visual subscriptions both succeed.
- Manual leave, room or user change, disconnect generation change, cleanup, or
  deadline expiry cancels timers and makes late results stale. Expiry uses the
  safe leave path and clears room and target state.
- Camera and local screen publishing stay off after interruption until the user
  explicitly restarts them. Restore microphone/deafen state from effective
  live-track state and the stored microphone preference.

## Deafen and Microphone State

- Deafen immediately disables local microphone tracks and publishes
  `deafened: true`, `mic: false`, and `speaking: false`.
- Store the pre-deafen mic preference separately from the observable mic-off
  state. Undeafen restores mic-on only if that preference was true and a live
  microphone track still exists.
- A previously muted user remains muted after undeafen. An ended or disconnected
  microphone invalidates a pending restore preference.
- Undeafen never creates a stream or requests permission for a receive-only
  user. Normal microphone-toggle behavior remains independent.
- Leave and a fresh join reset room-scoped restoration state so preference does
  not leak between sessions.

## Remote Streams and Audio Output

- Key remote streams by user and media kind. A camera, screen, and microphone
  from one user must not overwrite each other.
- An `ended` handler may remove state only when the current entry still
  references the stream that registered it. Wrap a standards-valid streamless
  remote track in a `MediaStream` so it receives a consumer.
- Each remote microphone or screen-audio stream owns one persistent hidden
  `HTMLAudioElement`, which remains attached to the original remote stream and
  is the hardware playback sink for its lifetime.
- From 0% through 100%, use native element volume. Above 100%, keep the native
  element playing and current but mute its hardware output only after a shared
  `AudioContext` successfully routes
  `MediaStreamAudioSourceNode -> GainNode -> AudioContext.destination`.
- Never attach a processed destination stream to the native element and never
  play native and boosted output audibly at the same time. Returning to 100%
  disconnects boost and immediately unmutes the live native path without
  replacing `srcObject` or calling `play()` again.
- Volume is listener-owned, integer-clamped from 0% to 200%, and persisted per
  listener for users. Temporary screen-stream levels disappear with the stream.
- A suspended context, setup failure, or unsupported/rejected non-default sink
  must disconnect boost and leave native playback audible at 100%.
- Apply the selected speaker to active and future native elements and to the
  boost context when supported. Commit a remembered output selection only
  according to the existing successful/unsupported routing contract.
- On autoplay `NotAllowedError`, keep the element mounted and register it for
  the global user-activation retry. Other playback errors remain observable.
- Cleanup pauses the element, clears `srcObject`, unregisters blocked/output
  state, and disconnects only Voxly-created nodes. Never stop receiver-owned
  remote tracks.
- Deafen mutes participant microphone streams, not subscribed screen-share
  audio. Screen audio still obeys its own volume, unsubscribe, and leave state.

## Screen Sharing

- Capture screen video at an ideal and maximum 1280x720 and 30 FPS.
- Set screen video `contentHint` to `detail` when supported.
- Apply `degradationPreference = "maintain-resolution"` only to the sender that
  carries the matching screen video track, including after renegotiation.
- A rejected or unsupported `setParameters` call is non-fatal. Do not affect
  microphone or camera senders.
- Do not add a fixed maximum bitrate, 1080p/60fps mode, user quality selector,
  thumbnail capture, or server-side media processing without a new design.

## Viewed-Room State

- Keep a missing voice snapshot distinct from a known empty snapshot.
- A known snapshot always wins, including an empty one.
- Fall back to the local participant only while the viewed room snapshot is
  missing and the viewed room is the active WebRTC room.
- Browsing a different empty voice room never moves the user or renders the
  local user there. Media streams and visual subscriptions remain scoped to the
  active WebRTC room.

## Library Tests

Add focused tests for state machines and failure paths before changing media
lifecycle behavior. At minimum preserve coverage for effective media,
acknowledgement timeout, stale-generation cleanup, reconnect ordering, deafen
restoration, output fail-open behavior, stream identity, screen sender
configuration, and viewed-room selection.

Run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
```
