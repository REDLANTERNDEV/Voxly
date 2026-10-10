# Unexpected Session sign-out investigation

Research date: 2026-10-10. Source baseline:
`49122082fda95728043ca248034cab3714d3e5c5`. The reported Device is Windows 11
with current or near-current Chrome; the member reports no deliberate sign-out.
He discovered the signed-out state after reopening Chrome/Voxly, approximately
30 minutes before the initial report. This establishes discovery time, not when
the Session actually ended.
No production database, request trace, exact browser version, or deployed build
was inspected. The incident's cause remains unproven.

## Verified history

- [c6ae77b0 — Let members link and recover their own devices](https://github.com/REDLANTERNDEV/Voxly/commit/c6ae77b0)
  (2026-09-01) introduced 15-minute token rotation and a two-minute retired-token
  grace window. Its authentication implementation revoked a Session when an
  old token arrived after that window, whether the replacement had reached the
  Device or not.
- [fcd5d72a — Require confirmed token delivery for reuse](https://github.com/REDLANTERNDEV/Voxly/commit/fcd5d72ab8ff7376ee9a6fba731f7d1b8eb462c3)
  (2026-09-19, 23:50 Europe/Istanbul) fixed that deterministic lost-response
  false positive: replacement delivery must first be confirmed, and otherwise
  HTTP retries rotation. This commit is an ancestor of the local baseline.
  That does not establish that production runs it.
- [ADR-0016](../adr/0016-session-reuse-requires-confirmed-delivery.md) is accepted
  and documents the fix. [ADR-0015](../adr/0015-session-tokens-rotate-and-report-their-own-theft.md)
  still says proposed and contains the earlier time-only rule; it explicitly
  links to ADR-0016 as its refinement. Use current implementation and ADR-0016
  when describing behavior.

## Verified behavior at the research baseline

The [Session module](../../apps/server/src/auth/sessions.ts) stores only token
hashes. HTTP renews a live Session to 180 days on the 15-minute touch throttle,
or immediately if fewer than seven days remain. It rotates a current token
after 15 minutes without changing the Session id. No separate idle timeout,
IP binding, or User-Agent binding exists.

A returned current token confirms all pending predecessors. The two-minute
reuse grace then runs from `replacement_seen_at`. A predecessor past grace
revokes the Session only when that confirmation exists. Unconfirmed
predecessors instead recover through HTTP; Socket.IO can admit them but cannot
write a replacement cookie. Confirmed predecessors are retained for 30 days;
unconfirmed predecessors are retained while their Session remains live.
The [migration](../../apps/server/src/db/database.ts) marks pre-fix rows
confirmed once, while preserving new unconfirmed rows across restarts.

The [web API helper](../../apps/web/src/api.ts) includes credentials and sends
best-effort `POST /api/session/confirm` after a rotation response. On realtime
disconnect, [Session checking](../../apps/web/src/app/useSessionController.ts)
requests `/api/me`: network errors and non-401 errors preserve authentication;
a 401 clears the displayed Account. Every reconnect 401 other than
`session_reused` receives the generic “Device was signed out” explanation,
including missing, unknown, or expired cookies. That wording alone cannot
prove owner action or credential theft.

HTTPS writes `__Host-voxly_session`, with HttpOnly, Secure, SameSite=Lax,
Path=/, Expires, and no Domain; plain HTTP writes `voxly_session`. Both are
read and the prefixed name wins. Cookies are scoped to the host and Secure
cookies require a secure request. Changing the host or browser profile can
therefore appear signed out without revoking the original Session.
[Session cookie implementation](../../apps/server/src/auth/sessions.ts),
[RFC 6265 sections 4.1.2.3 and 4.1.2.5](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1.2.3).

## Remaining questions and evidence

Local deterministic replay reproduced a second false-positive path on the
baseline, using an in-memory database and an HTTPS `__Host-` cookie jar:

1. After 16 minutes, rotate to A but hold its response.
2. After 121 seconds, the original cookie recovers to B. Deliver B and confirm
   it through `/api/session/confirm`.
3. Deliver the older A response last, replacing the jar's B cookie with A.
4. A initially authenticates. After another 121 seconds, A receives
   `401 session_reused`; the Session is revoked and `session.reused` is audited.

The replay drives actual HTTP routes through Fastify injection, with a mocked
clock and manually ordered cookie delivery. It does not run Chrome or establish
how often this response ordering happens in real networks. Two controls remain
signed in: omit the late response, or omit replacement confirmation. Only the
combination of late delivery and prior confirmation produces the false logout.

The member performed no sign-out in this replay. The previous fix handles a
response that never arrives; it does not handle this response arriving late
after a subsequent replacement has been confirmed. The
[replay artifact](../../scripts/session-reliability/replay.mjs) records the
controlled sequence. This establishes a baseline implementation gap, not that
the same ordering occurred for the reported member.

| Candidate                                                                         | Evidence needed before attributing this incident                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old server release or old retired-token lineage                                   | Deployed commit/image digest; Session and retired-token timestamps relative to the September 19 migration.                                                                                                                                                        |
| Late rotation response overwrites a newer cookie                                  | Local replay reproduced this path; attributing the incident still requires request/response timing or equivalent evidence from the affected Device. Existing lost-response and burst tests do not simulate a response later arriving after recovery confirmation. |
| Browser cookie missing or not sent                                                | Same host/profile and ordinary versus Incognito context; presence and attributes of the cookie, with its value hidden; request path, status, and safe error code.                                                                                                 |
| Session ended through another Device, Recovery, owner action, deletion, or expiry | Session `revoked_at`, `expires_at`, and `last_seen_at`; Account state; matching audit action and time.                                                                                                                                                            |
| Client shows an obsolete authentication failure after a new sign-in               | Reproduce delayed `/api/me` 401 racing successful authentication. Startup has a request gate; the reconnect check lacks a generation check.                                                                                                                       |

These are investigation branches, not incident conclusions. Cookie response
ordering is a credible protocol question: the standard warns about concurrent
Set-Cookie races and specifies that receiving the same name/domain/path
replaces the stored cookie. Confirmation proves a replacement was used at
least once; it does not prove the Device permanently retained it.
[RFC 6265 sections 4.1 and 4.1.2](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1).

Chrome documents that Incognito cookies disappear after every Incognito window
closes. Cookie expiry is also a maximum lifetime, not a storage guarantee.
Neither fact proves this member used Incognito or lost a cookie.
[Chrome Incognito help](https://support.google.com/chrome/answer/95464?hl=en),
[RFC 6265 section 4.1.2.1](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1.2.1).

Because he discovered this after reopening, check Chrome's **Settings → Privacy
and security → Site settings → Additional content settings → On-device site
data**, including site-specific exceptions. Chrome supports deleting stored
site data when all windows close. An enabled deletion setting would explain
cookie loss without a deliberate Voxly logout; it has not been checked for this
member. Closing ordinary Chrome alone is not a Voxly session-expiry trigger.
[Chrome on-device site data help](https://support.google.com/chrome/answer/14114868?hl=en),
[Session expiry implementation](../../apps/server/src/auth/sessions.ts).

The current [`session.reused` audit](../../apps/server/src/auth/sessions.ts)
contains the Account id and time, but no Session id or lineage. Owner
`session.revoked` targets a Session id; Recovery has `recovery.used`;
[`/api/logout`](../../apps/server/src/app.ts) has no audit event. Missing audit
evidence does not establish that nothing revoked a Session. Collect metadata
only; do not request Cookie/Set-Cookie values, access links, or raw HAR files.

## Next incident checks

1. Verify the deployed commit/image includes `fcd5d72a`; local history is not
   proof of the running build.
2. For this Account, inspect Session ids, `created_at`, `last_seen_at`,
   `expires_at`, and `revoked_at`, and corresponding audit metadata. An active,
   unexpired row with a missing browser cookie points toward lost local state;
   a revoked row with `session.reused` points toward confirmed-predecessor
   handling, but does not by itself prove the delayed-response race or theft.
3. Check the same Chrome profile, site hostname, Incognito status, and on-device
   site-data deletion settings. Record only whether the expected cookie exists
   and the `/api/me` status/error code, never its value.
4. If diagnosing a recurrence, capture safe request timing and session lineage
   metadata. Current audit granularity cannot distinguish a malicious copied
   cookie from a same-browser rollback. Improving that evidence and making the
   replay stay authenticated are follow-up implementation work; this research
   does not change the authentication protocol.

## Recovery and documentation gap

For an active member who needs access now, create an access link for the
existing Account. It lasts 15 minutes and is single use. A Link code from
another signed-in Device or the saved Recovery code are alternatives; Recovery
deliberately signs out other Devices. Do not issue an Invite to recreate the
Account. [Operator recovery guide](../self-hosting.md#member-lost-browser-access).

The [server guide](../../apps/server/AGENTS.md#authentication-and-sensitive-tokens)
and [operator guide](../self-hosting.md#recover-owner-and-member-access)
described renewal only in the final 30 days at the baseline. Source and rotation
tests already implemented the sliding touch-based behavior described above.
That discrepancy was documentation drift, not proof of the reported sign-out's
cause; the implementation follow-up corrects the documentation.

## Verification

- `npm run build -w @voxly/server` — passed.
- `node --test apps/server/dist/test/sessions.test.js apps/server/dist/test/session-rotation.test.js`
  — 39 passed, including the previous lost-response regression.
- `npm run build:tests -w @voxly/web` — passed.
- `node --test apps/web/dist-test/test/api.test.js apps/web/dist-test/test/auth-request-gate.test.js`
  — 15 passed.
- `node --test scripts/session-reliability/replay.mjs` — two controls passed;
  one intentionally red availability assertion reproduced `401 session_reused`,
  a revoked Session, and one reuse audit event. This standalone research replay
  is not included in the normal test suite.
- `npx eslint scripts/session-reliability/replay.mjs` — passed.
- `npx prettier scripts/session-reliability/replay.mjs docs/designs/2026-10-10-unexpected-session-logout-research.md --write`
  — formatted the two research artifacts.
- `npx prettier scripts/session-reliability/replay.mjs docs/designs/2026-10-10-unexpected-session-logout-research.md --check`
  and `git -c core.fsmonitor=false diff --check` — final artifact checks.

At the research stage, no production environment was accessed and no
implementation, commits, staging or deployment were performed.

## Implementation follow-up

The approved fix now promotes all three delayed-response scenarios into the
normal server suite (`session-delivery.test.ts`) and makes them pass. Immutable
cookie names protect newer credentials; confirmed stale-token rejection leaves
successors valid. Reconnect checks, safe diagnostics and real-browser coverage
are implemented. The original observations and verification above describe the
pre-fix baseline; see [ADR-0031](../adr/0031-stale-session-rejection-preserves-successors.md)
and the [operator guide](../self-hosting.md#investigate-unexpected-sign-outs)
for the new policy. Production incidents remain unattributed until their
available records are inspected.
