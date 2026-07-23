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
- Keep voice-channel activation as a deterministic transition: disconnected
  targets join directly, the active target opens, and a different active room
  requires move confirmation. The UI must navigate only after a successful
  acknowledged join.

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
- Owner mute stores a separate pre-moderation microphone preference, disables
  the published track, and acknowledges mic/speaking off. On owner unmute,
  restore only when that preference was on and the existing track is live.
- Clearing self-deafen while owner-muted must keep both the local control and
  every microphone track off before and during the server acknowledgement; do
  not briefly republish the saved pre-deafen preference.
- Owner deafen never changes the local microphone track or self-managed deafen
  state. It suppresses participant microphone playback only; screen-share audio
  remains governed by its existing subscription and volume path.
- Microphone testing treats automatic deafen as a room-scoped lease. Start
  playback only after deafen is acknowledged, restore undeafened state only
  when the lease changed it in the same active room, and preserve an existing
  user-selected deafen state. A failed test start must release its lease.

## Microphone Gain and Monitoring

- Apply the user input level through one Web Audio source and `GainNode` before
  branching to independent voice-publication and local-monitor destinations.
  Keep deafen free to disable the published track without silencing the monitor
  branch.
- Reuse the active microphone's monitor branch during a voice session. Open a
  separate selected-device capture only when no active microphone graph exists,
  and dispose that capture when an active graph replaces it.
- Input levels are integer-clamped from 0% to 200%, persisted per account, and
  applied live to both voice publication and monitoring. Resume the processing
  context from the initiating user action and fail safely when Web Audio cannot
  be created.
- Stop raw capture, generated destination tracks, graph nodes, and contexts
  exactly once across stop, device replacement, permission failure, component
  cleanup, logout, and stale async completion. Watch the raw device stream for
  disconnects; a generated destination track may remain live after its source
  ends.

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
- The per-account general output level multiplies participant, screen-share,
  and microphone-test playback levels, with the effective result clamped back
  to 0–200% before reaching the existing native/boost output path.
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
- Independently mute receiver playback for an owner-muted publisher even if a
  stale or modified peer still supplies an audio track.

## Connection Health Lifecycle

- Keep RTT classification in a pure helper and Socket.IO timers/listeners in a
  lifecycle hook. Probe immediately after connect and then every five seconds.
- Allow only one 2.5-second ACK wait at a time. Keep the latest five successful
  samples, display their median, and classify 0–150ms green, 151–300ms yellow,
  and greater than 300ms red; a timeout is degraded red state.
- Increment a connection generation on reconnect and ignore late ACKs or
  timers from an older generation. Cleanup disconnect delays, probe intervals,
  ACK timeouts, and socket listeners idempotently.
- Start the blocking overlay only after three continuous seconds disconnected.
  A reconnect alone does not dismiss it; wait for the first successful probe in
  the current generation.

## Screen Sharing

- Capture screen video at an ideal and maximum 1280x720 and 30 FPS.
- Set screen video `contentHint` to `motion` and apply
  `degradationPreference = "maintain-framerate"` only to the sender carrying
  the matching screen video track.
- Adapt each viewer's screen-video sender independently. Start near 480p/20 FPS
  at a 1.4 Mbps ceiling, promote healthy connections to 720p/30 FPS at 3 Mbps,
  and reduce sustained congestion as far as 360p/15 FPS at 700 Kbps.
- Sample sender statistics every two seconds. Promote initial quality after two
  non-congested samples, reduce one level after hard or sustained congestion,
  and require three healthy samples for recovery so profiles do not flap.
- Keep adaptive controller cleanup generation-safe and idempotent across
  unsubscribe, peer replacement, track end, share stop, leave, and hook
  cleanup. A late async result must not mutate a replacement sender.
- A rejected or unsupported stats or `setParameters` call is non-fatal and
  falls back to browser-native adaptation. Never affect microphone, camera, or
  screen-audio senders.
- Do not add browser-specific starting-bitrate SDP, simulcast/SVC, a manual
  quality selector, 1080p/60fps mode, thumbnail capture, or server-side media
  processing without a new design.

## Viewed-Room State

- Keep a missing voice snapshot distinct from a known empty snapshot.
- A known snapshot always wins, including an empty one.
- Fall back to the local participant only while the viewed room snapshot is
  missing and the viewed room is the active WebRTC room.
- A direct route may still render a viewed voice room without moving media, but
  activating a sidebar voice-channel name follows the join/move transition
  above rather than browsing. A different empty viewed room never renders the
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
