# ADR-0015 — Session tokens rotate, and a reused one reports its own theft

- **Status:** proposed
- **Date:** 2026-08-31
- **Context:** follows [ADR-0014](0014-members-link-their-own-devices.md); a stolen cookie is currently worth 180 days

## Context

A Voxly session token is worth 180 days. `sessions.expires_at` is set six months
out and extended whenever the holder comes within 30 days of it, so a member who
keeps using Voxly holds one token value, unchanged, indefinitely. There is no
idle timeout and no rotation. Whoever copies that cookie — from a shared
machine, a backup, an XSS that predates the `httpOnly` flag, a browser profile
left signed in — has the account for as long as they care to keep it, and
nothing anywhere will ever notice.

The prevailing advice is short-lived credentials: OWASP puts idle timeouts at
15–30 minutes for low-risk applications and absolute timeouts at 4–8 hours, and
current token guidance puts access tokens at 15 minutes, because "the longer it
lives, the longer a stolen token is dangerous".

Applied literally that would destroy the product. Voxly is a chat application
for a private group. Its peers are Discord and Signal, not a banking console,
and none of them sign a member out every eight hours. A member who has to
re-authenticate during a conversation will not use it.

The resolution is that **how long a member stays signed in and how long one
token value is worth something are different questions**, and only the second
one has to be short. OWASP names this separately as a renewal timeout:
regenerating the session identifier mid-session while keeping the member
authenticated. Conflating the two is what makes "15 minutes" look impossible
here.

Voxly also starts from a better position than the systems that advice is written
for. Sessions are opaque and stateful: every request looks the row up and honours
`revoked_at`, so revocation is already immediate. What is missing is not
revocation. It is **detection** — nothing today can tell that a token is being
held by two parties.

## Decision

The session row stays long-lived. The token value does not.

1. **Rotation.** A session token older than **15 minutes** is replaced on the
   next authenticated HTTP request. The server mints a new value, sets the
   cookie, and records the previous hash as superseded. The `sessions` row, its
   id, and everything bound to it are unchanged — the member is not
   re-authenticating, only re-carrying.
2. **A grace window.** A superseded token keeps working for **120 seconds** and
   cannot itself rotate again. Browsers fire requests in parallel and drop
   responses; without a grace window, ordinary concurrency and one lost
   `Set-Cookie` would both read as theft.
3. **Reuse detection.** A superseded token presented **after** its grace window
   means two parties hold copies of it. That session is revoked immediately, the
   event is audited, and the member is told — on their remaining Devices and on
   the Device list from ticket 01 — that a session was closed because its token
   was used twice.
4. **A sliding window, and no separate idle rule.** The expiry is pushed back
   out to a full 180 days every time the member is seen (on the same throttle as
   the touch, plus a floor that rescues anything already close to expiring). A
   member who keeps using Voxly is never signed out; a session nobody has
   touched for a whole window ends.

   This replaces an earlier plan for a 30-day idle timeout *alongside* a
   180-day absolute one. Two rules meant expiry could mean either of two
   things, and neither served the product: asking a self-hosted group to prove
   who they are again — for no event that happened — is exactly the friction
   this whole effort exists to remove. One sliding window says the same thing
   once: **unused for the window means over, used means still yours.**
5. **No client binding.** Sessions are not bound to IP address or User-Agent.

Point 5 is deliberate and is the one most likely to be argued with. Binding to
IP is standard advice and would be actively wrong here: a phone crossing between
Wi-Fi and cellular changes address constantly, and moving between devices and
networks is the exact thing ADR-0014 exists to support. Binding would produce a
stream of false positives in the one workflow this work is for. Rotation plus
reuse detection catches the same theft without guessing.

The security property this buys is not a shorter window. It is that **theft
becomes an event**. A copied cookie is worth at most fifteen minutes of quiet,
and the moment the real member's browser rotates, the thief's copy is
superseded — so the next use of either one collides and kills the session in
front of the member. That is the same principle ADR-0014 applies to the Recovery
code, applied to the credential every member carries all the time.

### Sequencing

**This ships after ADR-0014, not before.** Rotation converts some ordinary
network flakiness into a forced sign-out, and today a signed-out member has no
self-serve way back — they would have to ask the owner for an invite and arrive
as a different person. Link codes and Recovery codes have to exist first, or the
first dropped `Set-Cookie` becomes a support request.

### Cookie attributes

`httpOnly`, `secure` and `path=/` are already set and stay. Add the `__Host-`
prefix, which the cookie already satisfies and which stops a subdomain writing
it. Keep `sameSite: lax` rather than moving to `strict`: invite and claim links
are navigated to from outside, and `strict` would present those arrivals as
signed out. `lax` already refuses the cross-site POST that CSRF needs.

## Alternatives considered

**JWT access tokens with refresh tokens, 15 minutes and rotation.** The pattern
the 15-minute figure comes from. Rejected because Voxly would be paying its cost
to buy something it already has. A JWT's short life exists so that revocation
can propagate by expiry, since the token cannot be checked against a database
without giving up the statelessness that motivated it. Voxly's sessions are
opaque and looked up on every request, so revocation is already instant, and
adopting JWTs would trade that for a fifteen-minute delay plus a second token
type, a refresh endpoint, and a signing key to manage.

**Short absolute sessions — sign members out every 8 hours.** Rejected. It is
the literal reading of the guidance and the wrong reading for this product. It
degrades the thing members use daily to defend against something rotation
handles without them noticing.

**Binding sessions to IP or User-Agent.** Rejected — see point 5.

**Rotate on every single request.** Rejected: it multiplies writes by request
count, makes the grace window carry the entire correctness burden, and buys
almost nothing over fifteen minutes against an attacker who is using the
account rather than sitting on it.

**Do nothing, and rely on the Device list.** Rejected as insufficient on its
own. A Device list shows a member a session they do not recognise, which
requires them to look. Reuse detection fires whether or not anybody is looking.

## Consequences

- Rotation makes a lost response indistinguishable from theft once the grace
  window passes, so some members will be signed out for no reason they can see.
  The 120-second window makes it rare; ADR-0014 makes it recoverable; the copy
  has to make it comprehensible rather than alarming.
- The `sessions` table gains superseded token hashes, which means more rows per
  session and a cleanup job. Superseded rows can be dropped once their grace
  window has passed and the reuse question can no longer be asked — keeping them
  longer is what makes detection possible, so decide the retention deliberately
  rather than by whatever the cleanup interval happens to be.
- A live Socket.IO connection authenticates once at handshake and is bound to
  the session row, not the token value, so rotation does not disturb it. A
  reconnect reads whatever cookie the browser now holds. This must stay true:
  anything that re-reads the token on a live socket would start tripping over
  its own rotation.
- Reuse detection is only as good as the audit trail behind it. `session.reused`
  is the line an owner will want when a member says their account did something
  they did not do.
- Every credential in Voxly now follows one rule — a token is worth one use or
  one short window, and presenting a spent one is treated as evidence rather
  than as an error. Sessions, Link codes and Recovery codes should not drift
  apart on this.
