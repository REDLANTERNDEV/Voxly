# ADR-0016 — Session reuse requires confirmed delivery

- **Status:** accepted
- **Date:** 2026-09-19
- **Context:** refines ADR-0015 after a reproducible false-positive sign-out

## Context

ADR-0015 rotates the opaque token inside a long-lived Session and allows its
retired value for two minutes. It originally treated any later presentation of
that value as proof that two parties held the cookie.

That conclusion assumed the response carrying `Set-Cookie` reached the browser.
The server commits rotation before it sends the response. If the network drops
that response, the browser keeps the retired value; its next request after the
grace window is then indistinguishable from theft under the original rule. The
web client makes this more visible because a Socket.IO disconnect asks
`/api/me` whether the Device is still signed in: an unstable connection can
both trigger rotation and lose its response while the member is not actively
using the app.

The failure is deterministic: rotate, discard the response cookie, pass the
grace window, and present the original cookie. The old rule returns
`session_reused` and revokes the Session every time.

## Decision

Elapsed time is not sufficient reuse evidence. A retired token may revoke its
Session only after the replacement token has returned on a later request.

`session_tokens.replacement_seen_at` records that evidence without storing any
raw token:

1. Rotation stores the retired hash with no replacement-seen time and sends a
   new HTTP-only cookie.
2. The first request carrying the current token marks every pending retired
   value for that Session as having its replacement seen.
3. A retired token inside the grace window remains ordinary concurrency.
4. A retired token past grace whose replacement was seen is reuse: revoke the
   Session, audit `session.reused`, and tell the member.
5. A retired token past grace whose replacement was never seen is failed
   delivery. HTTP issues one new replacement for a concurrent request burst;
   Socket.IO admits the Device but cannot write a cookie.

Responses that rotate a token carry `X-Voxly-Session-Rotated: 1`. The web
client follows them with a best-effort authenticated request so successful
delivery becomes confirmed promptly. The cookie remains HTTP-only; JavaScript
learns that rotation happened, never the credential value. A failed
confirmation is not a failed member action: the next authenticated request can
confirm delivery, and an old cookie can still enter the recovery path.

Existing retired-token rows are marked confirmed once when the nullable column
is added. That preserves the security meaning they had before this decision.
New null values must remain null across restarts because null is protocol state,
not missing migration data.

## Consequences

- Losing a rotation response no longer signs a member out or falsely reports
  that another party used their Session.
- A copied predecessor remains provisionally usable until a replacement is
  observed. The immediate best-effort confirmation keeps that ambiguity short
  in the normal browser path.
- Once replacement delivery is confirmed, ADR-0015's loud theft response is
  unchanged.
- Recovery may be retried when multiple responses are lost, but a burst of the
  same old cookie issues only one replacement.
- Raw Session tokens remain absent from SQLite, logs, and JavaScript.

## Alternatives considered

**Increase the two-minute grace window.** Rejected. It reduces the frequency
but cannot fix a response that never arrives; the same false sign-out merely
happens later.

**Disable reuse detection.** Rejected. It restores availability by discarding
the security property ADR-0015 introduced, even after delivery is known.

**Bind the Session to IP address or User-Agent.** Rejected for the reasons in
ADR-0015: ordinary mobile network and browser changes would add new false
positives without proving cookie ownership.

**Store the raw replacement so it can be resent.** Rejected. A copied database
must not become a collection of usable login credentials.
