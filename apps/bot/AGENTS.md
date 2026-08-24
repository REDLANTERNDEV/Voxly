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
- `src/music.ts` decides what a `music:command` means: it owns at most one Set,
  serialises the requests that change it, and answers every one of them. It is
  the imperative half of the Queue — joining, spawning, playing, publishing —
  and holds no rule about what the Queue does.
- `src/playback.ts` is the other half and is pure: a state and one event in, the
  next state and a list of effects out. Every rule the Queue has lives here.
- `src/set.ts` is one Set — voice membership, mesh and player started and
  stopped together — and publishes the bot's own `speaking` state. A Set
  outlives any one Track. It also reports when the room's *roster* changes,
  which is not the same as a snapshot arriving.
- `src/mesh.ts` is the negotiation, applying `@voxly/shared`'s rules unchanged.
- `src/player.ts` turns one encoded Track into one output per Listener, reading
  from a `TrackBuffer` that may still be filling.
- `src/audio.ts` reads Ogg Opus and frames it as RTP. No codec runs here.
- `src/track.ts` is the resolver: a pasted link and the extractor's output, both
  turned into a Track. Pure, and the only place a source's vocabulary is known.
- `src/stream.ts` is the audio provider: yt-dlp piped into ffmpeg. It is not
  unit tested, and the reason is written at the top of the file: the decisions
  it does hold — two argument lists, two timeouts, which process's exit ends a
  Track — have no failure mode a unit test could catch, because the way they go
  wrong is a flag meaning something other than what was intended. Only the real
  binaries can say. Put anything testable in `track.ts` instead.
- `src/voxly.ts` reads the HTTP endpoints a browser reads, with the bot session.
- `test/` covers each of those. `test/playback.test.ts` is where the Queue's
  rules are asserted; a rule proved there should not be proved again through the
  responder. `test/mesh.test.ts` is the slow one on purpose:
  it runs real peer connections against a stand-in Listener that behaves like
  the browser client, because every interesting failure in this feature lives in
  the negotiation rather than in the arithmetic.
- `test/assets/chime.opus` is a real encoder's output, kept because a hand-built
  Ogg page is not evidence that a real one parses. It is a fixture, not a Track
  the product plays; the recipe for regenerating it is in the ticket 03 spike's
  README on the `prototype/headless-peer-audio` branch.
- `test/fixtures/` is example extractor output — its JSON as files, and the one
  line it prints on failure as named constants in `extractorFailures.ts`, so
  that six one-line `ERROR:` files do not sit in the repository looking like
  logs. Read its README before trusting any of it: it was written to yt-dlp's
  documented shape rather than captured from a live run, and it is waiting to be
  refreshed against one.

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

## The Queue

`src/playback.ts` is the design's primary test seam and the reason ticket 08's
rules can be asserted without a socket, a subprocess or a peer connection. Keep
it that way.

- **It performs no input or output.** No timers, no `crypto`, no logging, no
  awaiting. Anything a transition needs that the module cannot compute — an
  `entryId`, the Track a resolver produced — arrives on the event. Anything it
  wants done comes back as an effect for `music.ts` to carry out.
- **Effects are named in the product's words, not the library's.** `load` means
  "this Track should be fetched and handed to the player", not "spawn yt-dlp".
  Swapping the media path must not reach this vocabulary.
- **Effect order is part of the answer.** `publish` comes last on a change, so
  the room is told about a Queue that is already true; and it comes before the
  Set is torn down, so the bot is still a member of the room it publishes into.
- **Adding appends.** A link pasted while something is playing goes on the end.
  Nothing but an empty Queue starts a Track, and a paused Queue is not an empty
  one.
- **A Track that ends advances to the next**, and an empty Queue is not the end
  of the Set — the bot stays in the room with nothing queued, which is a state
  it really is in.
- **Nothing is prefetched.** The next Track's fetch starts when the previous one
  ends, not before it. Prefetching would cost a second concurrent extractor run
  against a source that rate-limits by address — the failure the design already
  names as realistic — for audio a skip or a removal may mean nobody hears. What
  it would buy is closing the gap while the prebuffer fills, and ADR-0004
  already accepted that gap as the price of starting early. By the code a
  boundary should be silence rather than lost music, because the player stalls
  instead of skipping ahead — but **nobody has heard one**, so how long that
  silence runs to is unmeasured. This is the first thing to re-read against a
  real Set, and the measurement is what should decide it rather than this
  argument.
- **The Queue is bounded** (`musicQueueMaxEntries`) because it is broadcast
  whole on every change. Ask `additionRefusal` before spending a link on the
  extractor; do not write a second bound beside it. Ask it only about the Queue
  the Track would actually join — a paste into a *different* room summons the
  bot away and takes the old Queue with it, so pre-checking the one that is
  about to stop existing refuses a member for somebody else's full evening.
- The Queue lives in memory and dies with the Set. Not persisted, by design.

Publishing the Queue belongs to `music.ts` and goes through the server, which
authorizes it rather than relaying it. Read
`docs/adr/0005-the-bot-publishes-the-queue.md` before changing that path.

- The bot cannot emit to a room. `music:publish` is a request; the server checks
  that the publisher is that room's Music bot and is still in the room, and only
  then gives the room the Queue.
- **Publish the Requester as an id.** The bot is handed one with every request
  and never sees a member list; the browser resolves the name. A nickname the
  bot copied would be the copy that goes stale on a rename.
- **Republish when the roster changes.** The server keeps no copy to hand a
  newcomer, so whoever just walked in would otherwise be the one person in the
  room looking at an empty panel. Roster, not snapshot: a snapshot lands every
  time anyone starts or stops talking, and republishing per syllable is a
  broadcast storm.

## Sources and Fetching

Read `docs/adr/0004-fetched-audio-path.md` before changing how a link becomes
audio. What it settles, in short:

- **Resolvers and the audio provider stay separate.** A resolver turns input
  into the identity of a Track; the one audio provider turns that identity into
  a stream. A future Spotify link is a resolver — its terms forbid it ever being
  a source of audio.
- **One framing path.** ffmpeg is asked for Ogg Opus (`-f opus`), not a raw
  stream, so a fetched Track and a file on disk are read by the same code.
  Adding a second framing path means a second place for lacing to be got subtly
  wrong, and the symptom of that is noise that sounds like a broken library.
- **Playback starts on a prebuffer and stalls on an underrun.** The clock stops
  where the audio ran out; it never skips ahead, and it never owes the wait back
  as a burst. A stall does not report `speaking: false` — the bot is still
  playing this Track — but it does re-arm the marker bit, because audio after
  silence is a new talkspurt.
- **Sequence numbers span a Set, not a Track.** Only the position within the
  Track and the marker bit reset when another Track is loaded.
- **The binaries are the operator's**, by path or by name on PATH, and their
  defaults are bare command names. Never hardcode a path that happens to work on
  the machine you are on, and never shell out — both programs are spawned with
  an argument list, and the URL handed to yt-dlp is rebuilt from a validated
  eleven-character id rather than passed through from what someone typed.
- **Answer every request.** The acknowledgement is the only route by which a
  member learns that their link will not play; a request that fails must still
  resolve rather than leave them watching a room where nothing happens.
- **Blame the right thing.** `extractor_failed` renders as "YouTube is refusing
  the Music bot right now", so it must mean that. A refused join, a missing
  binary or anything else of the bot's own is `bot_failed`; only a link that was
  fine but could not be fetched is the extractor's fault. A catch-all that
  reports everything as one of them sends members away to wait for a recovery
  that was never going to come.
- **Keep `resolveTimeoutMs` under the server's `botAckTimeoutMs`**, with room
  for the join that follows it. A bot cut off by the server reports
  `bot_timeout` in place of the reason it actually gave up.

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
in that server's member list. **yt-dlp and ffmpeg must be installed and findable**
— nothing in the test suite needs them, and nothing in the test suite proves the
fetch works either. Join a voice channel in a browser, paste a YouTube link, and
press the button:

- the bot joins, its row lights, and the Track you pasted is what plays;
- a dead link, a playlist and a live stream each produce their own sentence,
  and none of them puts a silent bot in the channel;
- it is *clear* — no stutter, no metallic edge, and no gap where the fetch had
  to catch up.

That last one still needs a person and headphones, and no test replaces it.
