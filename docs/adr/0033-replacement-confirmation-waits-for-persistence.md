# ADR-0033 — Replacement confirmation waits for persistence

- **Status:** accepted
- **Date:** 2026-10-24
- **Context:** refines [ADR-0016](0016-session-reuse-requires-confirmed-delivery.md)
  and [ADR-0031](0031-stale-session-rejection-preserves-successors.md) after a
  reproducible false sign-out

## Context

ADR-0016 lets a retired Session token count as stale only after its replacement
has come back on a later request. The web client sends that later request
straight away, because a rotated response carries `X-Voxly-Session-Rotated`.

An echo proves the browser _received_ the replacement. It does not prove the
browser _kept_ it. Browsers batch cookie writes to disk; Chromium, and therefore
WebView2 in the desktop app, commits roughly every thirty seconds. A browser,
phone tab or desktop app that is killed or quits inside that window reopens
holding only the predecessor. That predecessor is past grace and confirmed, so
the server answers `401 session_reused`, and the startup lookup signs the
member out. A rotation happens every fifteen minutes, so every Session meets
this window many times a day.

The failure is deterministic: rotate, confirm at once, pass grace, then present
only the original cookie.

## Decision

A sighting of the replacement counts as confirmed delivery only once the
replacement is at least **five minutes** old (`tokenPersistenceMs`). An earlier
sighting is ordinary use and records nothing. Until a later sighting confirms
it, the predecessor stays in ADR-0016's unconfirmed state, so presenting it past
grace takes the existing delivery-recovery path: one fresh credential, no stale
rejection, no audit line.

The web client schedules its best-effort confirmation just past that window
instead of sending it immediately, and a newer rotation restarts the wait.
Nothing else changes. Grace, recovery, and the rejection of a confirmed stale
credential after grace work as before.

## Consequences

- A browser that loses its newest cookie write by being killed keeps its
  Session.
- A copied predecessor stays recoverable for about five minutes longer than
  before. That is the same ambiguity ADR-0016 already accepts for a response
  that never arrived. ADR-0031 already removed automatic revocation, so the
  cost is a short delay before a stale copy is refused. Nothing that used to be
  refused is now accepted for good.
- A replacement that is echoed back only inside the window and never again
  stays unconfirmed until a later request. That is safe for the member, and it
  is the case the scheduled confirmation covers.

## Alternatives considered

**Lengthen grace.** Rejected for the reason ADR-0016 gives. Grace runs from the
confirmation, so lengthening it only moves the false sign-out later.

**Rotate less often.** It reduces how often the window opens but does not close
it.

**Accept the immediate predecessor unconditionally.** Rejected. A thief holding
it could keep minting successors forever, and theft would never become an
event.
