# Smart Invite and Adaptive Screen Share Design

## Goal

Make previously used invite links a safe way back into Voxly for authenticated
members, while preserving the existing invite validation contract for new
users. Make motion-heavy screen shares start smoothly and adapt independently
to each viewer without changing the peer-to-peer media architecture.

## Scope

This design contains two independent deliverables:

1. authenticated invite resolution across the web and server workspaces; and
2. per-viewer screen-share quality adaptation in the web media library.

They share one release goal but no runtime state or wire contract. They should
be implemented and tested as separate tasks so either change can be reviewed or
reverted independently.

## Authenticated Invite Resolution

### User experience

- An unauthenticated `/invite/:token` route keeps the current nickname,
  Turnstile, submit, accepted, and unavailable behavior.
- An authenticated `/invite/:token` route treats opening the link as intent to
  join. It resolves the token automatically without another confirmation.
- A valid unused invite for a server the user has not joined is consumed and
  the user is routed to that server's first text room, then any room, then the
  authenticated root.
- An active member who opens an unused invite for the same server is routed to
  that server without consuming the invite.
- An active member who reopens the exact invite they previously consumed is
  routed to that server even though the invite is no longer reusable.
- Any other unknown, expired, consumed, revoked, or unavailable invite keeps
  the generic invalid-token contract. If the authenticated user has another
  active server, the client routes to its first usable room. If no active
  server exists, the invite error surface remains available.
- A banned or removed membership is never restored merely because the user
  reopens an old invite.

### Server behavior and disclosure boundary

The existing `POST /api/invites/accept` route remains the only acceptance
boundary. The lookup must include `used_by_user_id`, but raw tokens remain
hash-only at rest and are never logged.

After authenticating the optional browser session and locating the hashed
token, evaluate the following cases in order:

1. If the invite was previously consumed by this same authenticated user and
   the user still has an active, non-banned membership in its server, return
   `409 { error: "already_server_member", serverId }`.
2. If the invite is unknown, expired, consumed by anybody else, or revoked,
   return the existing generic `404 { error: "invite_invalid" }`.
3. Preserve the existing banned-member rejection without consuming the invite.
4. If the authenticated user is already an active member, return
   `already_server_member` with `serverId` and leave an unused invite unused.
5. Otherwise perform the existing membership activation and one-time invite
   consumption atomically, then return the authenticated user and `serverId`.

The same-user exception does not reveal another user's token state and grants
no new membership. A different authenticated account receives the same generic
invalid response as an unauthenticated caller. Removed and banned users do not
qualify for the exception.

### Client orchestration

- Share concurrent invite-acceptance requests by token through one Promise,
  matching the existing access-claim pattern. Remove a failed request from the
  cache so an intentional retry remains possible.
- Route the automatic request through the authentication request gate so a
  stale initial `/api/me` result cannot overwrite a successful result.
- Preserve `serverId` from expected API error payloads rather than discarding
  it in the generic `ApiError` conversion.
- Use one shared authenticated-server navigation helper for success and
  `already_server_member`: refresh the server list, load the target rooms, and
  choose the first text room, then any room, then the authenticated root.
- For a generic invalid token, load the user's accessible servers and route to
  the first usable server. Do not infer the invite's server in the browser.
- Treat component unmount, route changes, and superseding authentication
  generations as stale. Late results must not navigate away from a newer route.

## Adaptive Motion Screen Sharing

### Capture and per-viewer boundary

Keep one local screen capture at an ideal and maximum 1280x720 and 30 FPS. Set
the screen video track's content hint to `motion`. Do not lower the source track
for one weak viewer because the same track feeds every peer.

Each viewer already has a separate `RTCPeerConnection` and matching screen
video sender. Configure and monitor that sender independently. Camera,
microphone, and screen-audio senders are outside the controller.

### Quality profiles

Apply the following standard `RTCRtpSendParameters` limits to the matching
screen video encoding:

| Profile | `scaleResolutionDownBy` | `maxFramerate` | `maxBitrate` |
| --- | ---: | ---: | ---: |
| `low` | `2` (about 640x360) | `15` | `700_000` bps |
| `startup` | `1.5` (about 853x480) | `20` | `1_400_000` bps |
| `high` | `1` (1280x720) | `30` | `3_000_000` bps |

Set `degradationPreference` to `maintain-framerate` for all three profiles.
These values are upper bounds, not promised bitrates. The browser remains
responsible for congestion control inside each profile.

### Sampling and transitions

Start every new viewer sender in `startup`. Sample the sender every two seconds
after its encoding parameters become available. Derive one normalized sample
from related `outbound-rtp`, `remote-inbound-rtp`, and selected candidate-pair
statistics when present:

- remote `fractionLost`;
- remote round-trip time;
- candidate-pair `availableOutgoingBitrate`; and
- outbound `qualityLimitationReason`.

Classify a sample as hard congestion when loss is at least `12%` or RTT is at
least `500 ms`. Classify it as congestion when loss is at least `5%`, RTT is at
least `300 ms`, available outgoing bitrate is below `80%` of the current
profile's maximum, or `qualityLimitationReason = "bandwidth"` appears in two
consecutive samples. The first startup sample ignores that quality-limitation
reason because normal browser ramp-up may report it transiently.

A healthy sample has no congestion signal, reports loss no greater than `2%`
when available, reports RTT no greater than `200 ms` when available, and has
enough reported available bitrate for `80%` of the next profile's maximum when
a higher profile exists. Missing optional fields are neutral rather than
failures.

Use these deterministic transitions:

- Two non-congested startup samples promote `startup` to `high` when reported
  available bitrate is absent or at least `2_400_000` bps, targeting a decision
  after about four seconds.
- One hard-congestion sample or two consecutive congestion samples reduce one
  profile level.
- After any reduction, three consecutive healthy samples promote one profile
  level.
- Change at most one level per sample and reset the consecutive counters after
  every transition.
- `low` and `high` are the lower and upper bounds; no transition crosses them.

If the stats API is unavailable, promote from `startup` to `high` after two
sampling intervals and rely on browser-native congestion control. If applying
encoding parameters is rejected or unsupported, stop the controller for that
sender and keep the share alive with the motion hint and native adaptation.
Do not repeatedly retry an unsupported parameter set.

### Lifecycle and cleanup

Key controller state by remote user and the exact sender/track generation.
Start it only for the sender whose `track` is the current local screen video
track, including senders created by later subscriptions or renegotiation.

Stop its timer and invalidate pending async work when:

- the viewer unsubscribes or leaves;
- the peer is removed or replaced;
- the local screen share stops or its video track ends;
- the local user leaves voice; or
- hook cleanup runs.

A late stats result or `setParameters` completion may mutate state only when
the peer, sender, track, and generation still match. Cleanup is idempotent.

### Standards and deliberate exclusions

The design uses the standard sender parameters and statistics described by the
[WebRTC specification](https://www.w3.org/TR/webrtc/), the standard motion
[MediaStreamTrack content hint](https://www.w3.org/TR/mst-content-hint/), and
the [WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/).

Do not add browser-specific SDP fields such as `x-google-start-bitrate`,
simulcast/SVC, a manual quality selector, 1080p/60 FPS capture, thumbnails, an
SFU, or server-side media processing. The standard exposes maximum bitrate but
does not guarantee a requested starting bitrate, so the four-second promotion
is a controller target rather than a promise that every browser will render
full quality by that instant.

## Component Boundaries

- Keep invite single-flight request state in `apps/web/src/api.ts` or a focused
  API helper, and route decisions in a deterministic web-library helper.
- Keep invite persistence, membership authorization, and disclosure decisions
  in `apps/server/src/app.ts` or a small server helper used by that route.
- Put screen profile definitions, stats normalization, and transition logic in
  a pure `apps/web/src/lib` module.
- Put browser polling, sender parameter application, generation checks, and
  cleanup in a focused media adapter consumed by `useVoiceMedia`.
- Keep `App.tsx` and `useVoiceMedia` responsible for orchestration rather than
  embedding profile or routing algorithms.
- No shared DTO or Socket.IO contract change is required.

## Error Handling

- Invite network failures do not destroy the authenticated session. They leave
  a recoverable invite surface or accessible-server fallback.
- Expected invite response codes retain their structured fields; unexpected
  errors retain the current generic presentation.
- A rejected stats read or sender parameter update never stops capture,
  changes another media sender, or reports screen sharing as off.
- Adaptive quality has no database, server, or realtime dependency and adds no
  user-visible copy.

## Verification

### Invite and authentication

- Server tests for a valid authenticated join, active-member duplicate, the
  same user reopening their consumed invite, another user opening that token,
  a removed or banned user, expiry, revocation, and unchanged token usage.
- API tests for structured `serverId` preservation, concurrent request sharing,
  and retry after failure.
- Pure route tests for success, already-member, generic-invalid fallback, no
  accessible servers, stale generation, and text-first room selection.
- Regression tests proving unauthenticated nickname, Turnstile, valid, and
  invalid invite behavior remains unchanged.

### Screen sharing

- Pure tests for profile constants, normalized stats, threshold boundaries,
  initial promotion, hard and sustained congestion, staged recovery, missing
  stats, and counter resets.
- Adapter tests proving only the matching screen-video sender changes and
  unsupported `getStats` or `setParameters` fails open.
- Lifecycle tests for subscription, renegotiation, peer replacement,
  unsubscribe, ended track, leave, hook cleanup, and stale async completion.
- Regression tests proving microphone, camera, screen audio, effective media
  state, and visual subscription behavior remain unchanged.

### Final commands

Run focused tests during each red-green cycle, then run:

```sh
npm run test -w @voxly/server
npm run test -w @voxly/web
npm run typecheck
npm run build
git diff --check
```

Inspect one healthy and one throttled viewer in a Chromium browser when
available. Confirm that the throttled viewer changes profile independently and
that stopping or switching a share leaves no active sampling timer.
