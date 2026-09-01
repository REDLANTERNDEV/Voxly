# ADR-0014 — A member links their own devices, and holds their own way back in

- **Status:** proposed
- **Date:** 2026-08-31
- **Context:** reported by members — somebody on a laptop cannot move to their phone

## Context

Voxly has no passwords and no email addresses. A member is a `users` row with a
nickname, and proof of being that member is an opaque token in `sessions`, held
as an HTTP-only cookie. Access is granted once, by an invite link, and never
again.

The `sessions` table is already many-rows-per-user and nothing enforces one
device. Multi-device works fine the moment a device holds a session. The gap is
narrower than it looks: nothing can *mint* a session for an existing account on
a device that has no cookie. `invites.ts` does `existingUser ?? createUser(...)`,
so redeeming an invite on a cookieless phone produces a different person rather
than a second device for the same one.

Two situations look alike and are not:

- **Both devices in hand.** A member on a laptop wants their phone, now, to keep
  talking while they move. This is what members actually reported.
- **The first device is gone.** Lost, wiped, reinstalled, cookies cleared. There
  is no signed-in device to help.

The second cannot be served by the first, and serving it badly is how accounts
get stolen. Whatever answers it is, by construction, a bearer secret that stands
in for the account — because with no password and no email there is nothing else
a member can prove.

The constraint that shapes the answer: **a member must be able to do this
without the owner**. Inviting is the owner's privilege; moving between your own
devices is not, and routing it through the owner would make a member's access to
their own account depend on somebody else being awake.

## Decision

Two paths, both self-serve, deliberately different in what they cost and what
they revoke.

### Link code — both devices in hand

1. A signed-in device calls `POST /api/devices/links` and is shown a
   **Link code**: 10 Crockford base32 characters (50 bits), grouped for reading,
   and the same value as a QR so the ordinary path types nothing.
2. The row lives in `device_links`, hashed exactly as sessions, invites and
   owner claims are. It is **single-use** and **expires in 90 seconds**.
3. The new device posts the code to `POST /api/devices/links/redeem` and is told
   `pending` — not given a session.
4. The originating device shows what is asking: *"A device wants to sign in as
   you"*, with the coarse device description and a confirmation number the new
   device is displaying. The member approves or refuses.
5. Only on approval is a session minted and the cookie set. The new device
   polls for the outcome, since it has no identity yet and cannot hold an
   authenticated socket.
6. **Nothing is revoked.** Both devices stay signed in, which is the entire
   point of this path.

### Recovery code — the first device is gone

1. Every account is issued a **Recovery code** when it is created, shown once,
   at full `createOpaqueToken()` entropy. It is stored hashed in
   `recovery_codes`, never in `users`.
2. Any signed-in device can regenerate it, which invalidates the previous one.
3. `POST /api/devices/recover` takes the code and **nothing else** — no
   nickname. The code identifies the account by hash lookup, and asking for a
   nickname would add no security while confirming to a stranger that the
   nickname exists.
4. Redeeming **revokes every other session for that account and issues a fresh
   recovery code**, which the member must save before continuing.

Point 4 is the security design, not a side effect. A stolen recovery code cannot
be used quietly: using it signs the real member out of every device and stops
their saved code working, so theft announces itself at the moment it happens
rather than months later. It also keeps the two paths honestly separated —
recovery means "I lost my device", and a member who merely wants a second one is
pushed to the link code, which costs them nothing.

### Applying to both

- Codes are hashed at rest, carried in a **POST body and never in a URL**, and
  never logged. This departs from the invite and owner-claim precedent of a
  one-use URL, deliberately: a URL lands in history, in referrers, and in
  screenshots, and these codes are handled on camera far more often than an
  invite is.
- A failed redemption gives **one generic answer** whether the code is unknown,
  expired, or already used. Three answers is an oracle.
- Both redeem routes get a rate limit tighter than `unauthenticatedWriteLimit`.
- `sessions` gains a coarse derived `label` ("Chrome on Windows") and a
  `last_seen_at`, and a member can see and revoke their own devices. Detection
  is half of the protection; an account you cannot inspect cannot be defended.
- Both paths refuse `is_bot` accounts, which authenticate by ADR-0003 and have
  no business holding either.
- Both paths write audit rows. `device.linked` and `device.recovery_used` are
  the two lines an owner will want when somebody says it was not them.

## Alternatives considered

**Owner-issued re-access links.** The owner mints a one-use link for an existing
account. Rejected as the primary path: it makes a member's access to their own
account depend on the owner being reachable, which is exactly what was asked to
be avoided. The owner keeps the tools they already have — revoking sessions,
banning — and the operator CLI remains the ultimate backstop for an owner who
loses everything.

**A link code that signs the new device in immediately, notifying afterwards.**
Simpler, and it was the first shape considered. Rejected because Voxly's members
share their screens constantly, and a code that is sufficient on its own is a
code that can be read off a stream. Ninety seconds narrows that window; it does
not close it. Requiring approval on the device that minted the code — which is,
by definition, in the member's hand on this path — closes it, at the cost of one
polling endpoint.

**Passwords.** Rejected as disproportionate and, on its own, worse. It adds
storage, strength rules, and a reset flow to a product with no email to reset
through — so the reset would end up being a bearer code anyway, which is what
this ADR specifies without the password in front of it.

**Long-lived per-device tokens with no expiry on the link code.** Rejected
because the whole risk sits in how long a transferable secret is worth
something. The link code is worth 90 seconds and one use.

**Nothing, and let members burn a second invite.** Rejected: it does not produce
a second device, it produces a second person, with a separate identity and
separate history. It is also what members are doing today, and it is why this
was reported.

## Consequences

- A member holds two secrets of very different value: a code worth 90 seconds,
  and one worth their account until they replace it. The interface has to make
  that difference obvious, or the recovery code gets treated as casually as the
  link code.
- Recovery necessarily signs the member out everywhere. Somebody who reaches for
  it when they meant to link a device will be surprised. The copy has to make
  the cost plain before the code is entered, not after.
- A member who loses their device *and* their recovery code has no self-serve
  way back. That is deliberate — the alternative is a path that does not require
  holding anything, and no such path is safe here. The owner can still ban the
  lost account and invite them fresh, and they lose their history.
- Two more token shapes join sessions, invites and owner claims. All five now
  follow one pattern — opaque token, hashed at rest, expiry and single use in
  the row — which is worth keeping true as they multiply.
- Sessions become things members look at rather than an owner-only console, so
  the labels are member-facing copy and must not leak more than they need to.
- **Voice is not ready for a member to hold two Devices at once, and this makes
  that reachable.** Voice membership is `Map<roomId, Map<userId, …>>` — one slot
  per account — so a second Device joining the same room overwrites the first
  member state while the first Device keeps its peer connections. Worse,
  `voice.ts` routes every offer, answer and ICE candidate to *all* of a user's
  sockets, so two Devices signed in as one account would both answer every
  negotiation. Voice must gain an explicit rule before linking ships; see the
  Devices tickets.
- Session tokens are still worth 180 days each, which is the credential a member
  carries all the time and the one most worth stealing. Linking Devices makes
  that worse by multiplying how many exist. [ADR-0015](0015-session-tokens-rotate-and-report-their-own-theft.md)
  answers it, and deliberately ships *after* this one — rotation needs a
  self-serve way back in before it can be allowed to sign anybody out.
