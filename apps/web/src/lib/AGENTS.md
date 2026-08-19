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

## Peer Negotiation

- Who offers, and who yields when both offer at once, come from `@voxly/shared`.
  `voiceNegotiation.ts` re-exports them and must not define its own copy.
- Every offer carries an audio section. A member who sends no audio adds a
  `recvonly` transceiver first, because an answerer cannot add a section the
  offer left out. With nothing else to publish the offer would carry no sections
  at all and deadlock the pair — the answer is not applicable, the offerer stays
  in `have-local-offer`, later offers collide with it, and recovery rebuilds the
  same empty offer; with a camera it looks healthy and is simply never heard.
  Keep the check on the one path that reaches `createOffer`.
- Re-check the offer generation, the tracked peer, and the signaling state after
  every `await` in the offer path. A peer's own offer can arrive during
  `createOffer` and move the connection out from under the result.

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

## Notification Sounds

- Cues are static files under `public/sounds` played through short-lived
  `HTMLAudioElement` instances, one cached per cue. Apply the shared output
  device before playback so a cue never escapes to the system default after the
  listener chose another sink. A missing file, a revoked device, or a blocked
  autoplay policy degrades to silence and never surfaces an error.
- Derive arrivals and departures by diffing the active room's voice snapshot,
  not from a separate event. A room change or the first snapshot in a room only
  establishes the baseline, so joining a populated room announces nobody.
  Exclude the listener from that roster; their own transition is the join or
  leave cue.
- Self join and leave follow the active room id. Reconnect and recovery keep
  that id, so restoring a session stays silent.
- Deafen implies a microphone change; play only the deafen cue for that
  transition. While deafened, every cue stays silent except the two that report
  the deafen state itself. Owner-enforced deafen silences cues the same way.
- Message cues follow the unread rule: never the listener's own message, and
  never the room already on screen in a focused window.
- Preferences are per account in local storage: a master switch, a level
  clamped to 0–100%, and one switch per category. The level is independent of
  the general output level, which governs voice playback.
- Repeats of the same cue inside a short window are dropped rather than
  restarted, so a burst of arrivals produces one sound instead of a stutter.

## Landing Analytics

- `analytics.ts` loads nothing until `/api/config` reports a provider, and only
  while the public landing page is mounted. A deployment that configured none
  must issue no request to any analytics host.
- Keep automatic route tracking off. Umami patches `history` when left alone and
  would report authenticated in-app paths, which carry server and room IDs; the
  single landing view is reported explicitly instead. gtag does not follow SPA
  navigation on its own, so its `config` call is that view.
- Pass the deployment's reported endpoint to the tag in whatever form that
  provider expects — Umami's `data-host-url`, gtag's `transport_url`. Left to
  itself a tag derives its own destination, which can differ from the origin the
  server allowed, and every event is then dropped by the browser rather than by
  us.
- Keep the bootstrap out of inline `<script>`; the strict `script-src` policy
  carries no `'unsafe-inline'`. gtag reads its commands from the `arguments`
  object the canonical snippet pushes, so forward that rather than an array.
- A blocked, unreachable, or misconfigured analytics host is not an application
  error. Swallow the failure and cache nothing that would prevent a later retry.

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
- Capture processing is fixed, not preference-driven: noise suppression, gain
  control, and echo cancellation are all requested on, as plain booleans so an
  unsupported device degrades instead of rejecting the capture. Never send an
  `exact` form. Screen-share audio stays unspecified and untouched.
- The browser constraint cannot carry the user's suppression preference. Chrome
  runs one processing module per capture, echo cancellation engages it, and
  `noiseSuppression: false` does not reliably disengage the suppressor inside
  it, so the toggle was inaudible on the most common browser. The constraint
  also cannot be changed on a live track, so honouring it meant releasing the
  device and reopening it — seconds of delay, published silence in between, and
  no fallback if the reopen failed.
- The preference therefore drives a stage in the capture graph: a high-pass
  followed by a downward expander gated by the shared adaptive-floor estimator.
  It applies on the next audio block and never disturbs the capture. Turning it
  off changes values on that graph rather than its shape — the filter is
  bypassed and the expander held open, never unwired.
- The expander closes to a floor, not to silence, and every gain change is
  ramped rather than assigned. A gate that closes fully chops the room in and
  out, and a stepped gain is a discontinuity, which is audible as a click.
- The expander measures the filtered signal before its own gain, so its reading
  never chases the reduction it just applied.
- Only a device change re-captures. It holds both captures at once, so a failed
  reopen always leaves the previous microphone to fall back to; record the
  device each graph was opened with so unchanged settings never reopen it.
  Preserve mute, deafen, and owner-mute on the replacement track.
- Support means "can this browser build the graph", not "does it advertise the
  constraint". Probe for an audio context.
- The preference is stored per account in local storage, defaults on to match
  browser behavior, and applies to both voice publication and the microphone
  test. A microphone test that owns its capture applies the preference to its
  own graph; a shared monitor branch inherits the voice graph, including its
  suppression stage, and must not open a second device.

## Speaking Detection

- Speaking detection reads float time-domain samples, never the 8-bit view: one
  step of that view is coarser than the levels a quiet speaker produces, so
  quiet speech quantized to zero and never armed the gate.
- The analysis window must be longer than the sampling interval, so consecutive
  reads overlap. A short window sampled infrequently leaves most of the signal
  unexamined and drops out between syllables.
- The trigger is relative to a measured noise floor, not a fixed level: a level
  that suits a loud headset mic never arms for a quiet or distant one. The floor
  tracks minima — falling towards anything quieter within a couple of samples,
  creeping up by a bounded fraction otherwise — so a noisy room raises the
  trigger within a second while sustained speech cannot drag its own threshold
  up behind it. An absolute floor still guards against arming on silence.
- Keep hysteresis and a release window so a syllable gap does not flicker the
  indicator, and keep the estimator shared with the suppression stage so what
  the gate treats as speech and what the ring shows can never disagree.

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
