# ADR-0032 — Writes and realtime handshakes check their Origin

- **Status:** accepted
- **Date:** 2026-10-24
- **Context:** amends the CSRF reasoning in [ADR-0015](0015-session-tokens-rotate-and-report-their-own-theft.md) (Cookie attributes); follows the October 2026 security audit

## Context

ADR-0015 kept the session cookie `SameSite=Lax` and reasoned that "`lax` already
refuses the cross-site POST that CSRF needs." That holds for a cross-_site_
page. It does not hold for a page on a sibling subdomain of the same registrable
domain, which is _same-site_: the browser attaches a Lax cookie to its form
POSTs and to its WebSocket handshakes. Fastify accepts `text/plain` bodies, so a
form on such a page reached every write that ignores its body (owner ban,
session revoke, kick, invite revoke, logout), and a WebSocket from it was
authenticated as the member and joined to every server room they belong to.
Under HTTPS a sibling could also plant the unprefixed `voxly_session` name for
the parent domain, which the server still read, and sign a member into the
sibling's account.

## Decision

When the operator sets `VOXLY_PUBLIC_URL`:

- A non-GET/HEAD/OPTIONS request whose `Origin` is present and is not the
  installation's origin is refused with a generic `403 forbidden`.
- A Socket.IO handshake whose `Origin` is present and is not the installation's
  origin is refused.
- A request without `Origin` passes. Browsers always send it on writes and
  WebSocket handshakes; the Music bot and the CLIs are Node clients and never
  do.

Independently of `VOXLY_PUBLIC_URL`, an HTTPS installation reads the unprefixed
session cookie names only from callers that are not browsers (no `Origin` and no
`Sec-Fetch-Site`). A browser presents only `__Host-` names, which a sibling
cannot write. The Music bot keeps working: it is told the plain name and sends
it from Node.

The policy lives in `apps/server/src/originPolicy.ts`; the cookie filter is
`withoutUnprotectedSessionCookies` in `auth/sessions.ts`.

## Consequences

- Every browser must reach the installation at exactly `VOXLY_PUBLIC_URL`. A
  member opening it by LAN IP or another hostname can read but cannot write or
  connect realtime. Development uses `VOXLY_PUBLIC_URL=http://127.0.0.1:5173`
  so the Vite proxy's forwarded Origin matches.
- An installation without `VOXLY_PUBLIC_URL` has no Origin check; it keeps the
  cookie rule under HTTPS. The self-hosting guide sets it in every example.
- `SameSite=Lax` stays, for the reason ADR-0015 gives: invite and claim links
  arrive by navigation from outside.
