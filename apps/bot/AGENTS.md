# Music Bot Instructions

These instructions apply to `apps/bot` in addition to the repository root
guidance.

## Responsibilities and Structure

The bot workspace is a headless client of the Voxly server. It authenticates as
each server's Music bot account, holds one connection per account, and joins
voice rooms as an ordinary peer. It is not a second server: it has no database,
no HTTP surface, and no authority over anything.

- `src/config.ts` resolves the two operator values and refuses to start without
  both. A configuration fault exits; everything after that logs and keeps going.
- `src/credentials.ts` performs the credential exchange and validates the
  response shape before anything downstream trusts it.
- `src/presence.ts` owns the connection lifecycle: one socket per bot account,
  the reconnect loop, and the hook each connected server's playback attaches to.
- `src/main.ts` is the composition root: it reads the Track once, wires a
  responder onto every connection, and installs the process-level handlers.
- `src/socket.ts` narrows a live socket to the events a Set may use.
- `src/music.ts` decides what a `music:command` means: it owns at most one Set
  and serialises the requests that change it.
- `src/set.ts` is one Set — voice membership, mesh and player started and
  stopped together — and publishes the bot's own `speaking` state.
- `src/mesh.ts` is the negotiation, applying `@voxly/shared`'s rules unchanged.
- `src/player.ts` turns one encoded Track into one output per Listener.
- `src/audio.ts` reads Ogg Opus and frames it as RTP. No codec runs here.
- `src/voxly.ts` reads the HTTP endpoints a browser reads, with the bot session.
- `assets/chime.opus` is the bundled Track. Synthesised, so nothing shipped here
  is licensed audio; the recipe for regenerating it is in the ticket 03 spike's
  README on the `prototype/headless-peer-audio` branch.
- `test/` covers each of those. `test/mesh.test.ts` is the slow one on purpose:
  it runs real peer connections against a stand-in Listener that behaves like
  the browser client, because every interesting failure in this feature lives in
  the negotiation rather than in the arithmetic.

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

## Voice and Playback

The bot is a peer in the mesh, not a server-side mixer. Read
`docs/adr/0001-music-bot-is-a-mesh-peer.md` before changing how audio reaches a
Listener, and `docs/adr/0002-werift-for-the-bot-webrtc-stack.md` before reaching
for a library feature.

- Apply `shouldInitiatePeerConnection` and `shouldIgnoreIncomingOffer` from
  `@voxly/shared` exactly as the browser does. The bot deviated from them in the
  ticket 03 spike, to work around a client that offered no media sections when
  it had no microphone; that defect is fixed and the workaround is gone. Do not
  reintroduce a private negotiation rule — both halves of a pair must reach the
  same answer from the same two user ids.
- Decide whether to offer from *having offered*, not from the peer being new. A
  signal from a Listener often beats the room snapshot through the server, so
  the peer already exists by the time the snapshot lands; keying on newness
  skips the offer and leaves the room silent.
- Re-check the signalling state after every `await`. A peer's own offer can
  arrive mid-`createOffer`, and applying a local offer then throws — from a
  fire-and-forget call, that is an unhandled rejection.
- Encode once. Every Listener gets the same Opus bytes and its own packet
  object; werift's sender mutates and caches what it is handed. A change that
  makes the encode per-Listener defeats the reason the library was chosen.
- Attach a Listener's output track when the connection is built, not when
  playback starts, so starting the music needs no renegotiation.
- The bot must report its own `speaking`. Nothing in Voxly measures received
  audio — the indicator everyone renders comes from the sender's own
  `voice:setMediaState` — so a bot that stays quiet about itself plays into a
  room where its own row never lights. It joins with `mic: true` for the same
  reason: the server clamps `speaking` off for a microphone that is off.
- The bot must enforce its own silence. Media is peer-to-peer, so the server
  cannot stop packets it never sees: owner mute and the AFK room's forced mute
  are advisory for media and the bot has to honour them itself. An eviction —
  `voice:forceLeave` — ends the Set, because holding one for a membership the
  server has dropped leaves peer connections open and makes the next Summon
  play into nothing.

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
in that server's member list. Join a voice channel in a browser and press Play:
the bot joins, its row lights while it plays, and the audio is the bundled
Track. Judging that it is *clear* — no stutter, no metallic edge, no dropout at
the loop point — still needs a person and headphones, and no test replaces it.
