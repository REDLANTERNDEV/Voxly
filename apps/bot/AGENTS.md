# Music Bot Instructions

These instructions apply to `apps/bot` in addition to the repository root
guidance.

## Responsibilities and Structure

The bot workspace is a headless client of the Voxly server. It authenticates as
each server's Music bot account and holds one connection per account. It is not
a second server: it has no database, no HTTP surface, and no authority over
anything.

- `src/config.ts` resolves the two operator values and refuses to start without
  both. A configuration fault exits; everything after that logs and keeps going.
- `src/credentials.ts` performs the credential exchange and validates the
  response shape before anything downstream trusts it.
- `src/presence.ts` owns the connection lifecycle: one socket per bot account,
  and the reconnect loop.
- `src/main.ts` composes them and installs the process-level handlers.
- `test/bot.test.ts` covers configuration, the exchange, and the reconnect loop
  through injected doubles, so no test needs a live server.

## Authentication

The mechanism and its alternatives are recorded in
`docs/adr/0003-music-bot-service-account-credentials.md`. Read it before
changing how the bot gets in.

- The bot holds `VOXLY_BOT_TOKEN`, not a session. It exchanges that credential at
  `POST /api/bot/sessions` for one ordinary session per bot account and presents
  each on its handshake as the cookie the server named in the response.
- Take the cookie name from the response rather than hardcoding it. The server
  owns that name and the bot is not a browser that was told one at sign-in.
- Re-run the exchange on every reconnect. Sessions expire, and the exchange
  retires the ones it replaces, so a replayed cookie is a connection that will
  never authenticate again. This is also how a server created after the bot
  started gets picked up.
- Socket.IO's own reconnection stays off for the same reason: it would replay a
  stale cookie forever.
- A dropped connection retires the whole set rather than reconnecting one. The
  sessions were minted together and the next exchange revokes the previous ones,
  so refreshing a single account would invalidate the credentials the others are
  still holding.
- Never log a session token or the operator credential, and never put either in
  a URL. Report which value is missing or rejected, not its content.

## Boundaries

- The bot uses only the server's public HTTP and Socket.IO surface. It must not
  import `apps/server`, open the SQLite file, or rely on sharing a host with the
  server; it is expected to run in its own container.
- Anything the bot and the server must agree on belongs in `@voxly/shared`.
- The bot is an ordinary member. It holds no elevated permission and must not
  assume one: an action the server refuses for a member is refused for the bot.
- Keep a configuration fault fatal and a runtime fault survivable. A bot that
  exits on a dropped connection is a bot the operator has to babysit.

## Verification

```sh
npm run test -w @voxly/bot
npm run typecheck -w @voxly/bot
npm run build -w @voxly/bot
```

For an end-to-end check, start a server with `VOXLY_BOT_TOKEN` set, then run the
bot with the same token and `VOXLY_SERVER_URL`; the Music account appears online
in that server's member list.
