# ADR-0003 — The Music bot authenticates as a service account with an operator-held credential

- **Status:** accepted
- **Date:** 2026-08-22
- **Context:** ticket 05, "The Music bot exists and appears online"

## Context

Every Voxly server gets its own Music bot account, created the same way it gets
its AFK room. The bot runs as a separate Node process, and nobody is going to
sit in front of it and log in — so it needs a way to become that account on its
own, every time it starts and every time it reconnects.

Voxly's only existing authentication is a browser session: an opaque token,
stored hashed in `sessions`, presented as an HTTP-only cookie and read again by
the Socket.IO handshake. There is no password, no OAuth provider, and no
identity infrastructure beyond invite links and one-time claim links, all of
which are shaped for a human with a browser.

Two constraints shape the answer. Servers are created at runtime, so whatever
the operator configures cannot be a per-account secret — an account for a server
that does not exist yet cannot have one. And the bot will later move into its
own container (ticket 14), so anything that depends on sharing a host with the
server is a dead end.

## Decision

The Music bot is a **service account** that authenticates with an
**operator-held bootstrap credential exchanged for an ordinary session** — the
standard machine-to-machine pattern of a long-lived secret at rest traded for a
short-lived credential in use.

1. Each bot account is an ordinary `users` row with `is_bot = 1` and an ordinary
   active `server_members` row. `is_bot` is presentation and moderation policy;
   nothing in the product consults it to decide what a caller may *do*.
2. The operator generates one secret and puts it in the environment of both
   processes as `VOXLY_BOT_TOKEN`. The server holds it in memory only — never in
   SQLite, never in a log — the same treatment `TURN_STATIC_AUTH_SECRET` and
   `OWNER_BOOTSTRAP_TOKEN` get.
3. The bot calls `POST /api/bot/sessions` with `Authorization: Bearer <token>`.
   The server compares digests with `timingSafeEqual` and returns one freshly
   minted session per bot account, along with the name of the session cookie.
4. The bot presents each session on its Socket.IO handshake as that cookie. From
   there it is an ordinary member and every existing authorization check applies
   to it unchanged.
5. Bot sessions last an hour, and minting new ones revokes that account's
   previous sessions, so at most one credential per bot account is ever live.
   The bot re-runs the exchange on start and on every reconnect — which is also
   how it picks up a server created after it started.

Without `VOXLY_BOT_TOKEN` on the server, the endpoint is not registered at all.
The bot accounts still exist and simply appear offline.

## Alternatives considered

**A long-lived token per bot account, issued at creation (Discord's model).**
Rejected because the operator would need somewhere to keep, distribute and
rotate one secret per server, and could not configure one at all for a server
created later. One bootstrap credential covers accounts that do not exist yet.

**A second authentication path inside the Socket.IO handshake — the bot token
straight on the connection.** Rejected because it creates a code path that never
touches `sessions`, and every authorization check downstream would then need a
second answer for "what if this socket is a bot". Exchanging for a real session
keeps exactly one authentication model in the codebase.

**mTLS, or OAuth2 client credentials.** Rejected as disproportionate. Neither has
any existing footing in a self-hosted single-container deployment, and both add
certificate or token-server operations to a product whose entire premise is that
one person can run it.

**Trusting loopback, or a Unix socket.** Rejected because it stops being true the
moment the bot moves to its own container or another host, and because "it came
from localhost" is not an authorization boundary anyone can audit.

## Consequences

- `VOXLY_BOT_TOKEN` is a deployment secret of the same class as the TURN shared
  secret: whoever holds it can act as every Music bot on that deployment. It is
  worth exactly one bot per deployment and nothing more — it grants no owner
  powers, and each session it mints is scoped to one ordinary membership.
- The credential must be configured in two places, and a mismatch is a start-up
  failure rather than a silent degradation. Both processes say which value is
  missing or rejected.
- Bot accounts appear in the member list whether or not the bot process is
  running, which is what makes "the bot is offline" visible rather than the bot
  simply being absent.
- Kicking, banning, the invite grant, and access links are refused for a bot
  account by the server, not merely hidden by the client. Voice moderation —
  mute, deafen, disconnect, move — is deliberately still allowed: it means the
  same thing for a bot as for anyone else, and the bot is required to honour it.
- Because minting retires the previous session, two bot processes pointed at the
  same deployment evict each other rather than sharing it. That is the intended
  reading of one live credential per account, and each eviction goes through the
  bot's ordinary backoff, so the pair settles into slow alternation rather than a
  hot loop. Run one.
