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
  next state and a list of effects out. Every rule the Queue has lives here, and
  so does the Set log, which is part of the state a Set holds.
- `src/set.ts` is one Set — voice membership, mesh and player started and
  stopped together — and publishes the bot's own `speaking` state. A Set
  outlives any one Track. It also reports when the room's *roster* changes,
  which is not the same as a snapshot arriving, and it is where the bot reads
  its own moderation state and stops sending.
- `src/mesh.ts` is the negotiation, applying `@voxly/shared`'s rules unchanged.
- `src/player.ts` turns one encoded Track into one output per Listener, reading
  from a `TrackBuffer` that may still be filling.
- `src/audio.ts` reads Ogg Opus and frames it as RTP. No codec runs here.
- `src/track.ts` holds both resolvers: a pasted link, a typed name, and the
  extractor's output for either, turned into a Track or a list of Results. It is
  also where an input is decided to be one or the other, and where a fetch that
  gave up is turned into the reason the room is told. Pure, and the only place a
  source's vocabulary is known.
- `src/stream.ts` is the audio provider: yt-dlp piped into ffmpeg, and the
  search that asks yt-dlp the same source a different question. It is not unit
  tested, and the reason is written at the top of the file: the decisions it
  does hold — three argument lists, three timeouts, which process's exit ends a
  Track — have no failure mode a unit test could catch, because the way they go
  wrong is a flag meaning something other than what was intended. Only the real
  binaries can say. Put anything testable in `track.ts` instead.
  Since ticket 13 it holds one more decision of that kind and it is worth
  naming, because it is load-bearing and the exemption covers it for the same
  reason: **when there is enough evidence to say a fetch failed.** Both
  programs' exits and the extractor's stderr arrive after the encoder's stream
  ends, so the file asks the question at `finish` and again as each program
  *closes*. What the answer then *is* lives in `track.ts` and is covered there;
  what the ordering buys is guarded at the responder seam in `music.test.ts`
  ("keeps the line when the player then reports the end of the Track that
  failed"). Neither test runs a binary, and nothing here has.
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
  refreshed against one. `search.json` is the newest and the least evidenced —
  **no query has ever been put to yt-dlp from this repository**, so the shape of
  a flat search listing is documentation here, not a transcript.

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
- **The player never replays a Track that finished.** What follows a Track is
  the Queue's answer and the Queue loads whatever it wants played, so a `play`
  for audio it did not just load can only be a mistake above — and replaying on
  one puts the wrong Track in front of the room, which is worse than silence and
  much harder to recognise. Loading a Track clears it, so every real advance
  still plays. This replaced the older reading, that a Play button which did
  nothing looks broken; the panel now disables the button instead.
- **The bot enforces its own silence, by reading its own `media.mic`.** Media is
  peer-to-peer, so the server cannot stop packets it never sees: owner mute and
  the AFK room's forced mute are advisory for media and the bot honours them
  itself, in `set.ts`, off the voice snapshot. Read the server's **conclusion**
  and not its reasons — `normalizeVoiceMedia` is where both rules end up, the
  AFK room is not on the snapshot at all, and re-deriving them from `moderation`
  would be a second opinion that can disagree with the server's. ADR-0009.
- **Silencing is not pausing.** The Queue is not told, goes on advancing, and
  still reports `playing` — which is honest: the panel reads the Queue and the
  bot's own row carries the mute the server enforced, exactly as it would for a
  person cut off mid-sentence. So the Set holds "what the Queue asked for" apart
  from "what the player is doing"; the microphone coming back resumes only the
  first, because an owner lifting a mute is not a member pressing Play.
- **The bot is summoned into a room and never moved into one.** `voice:moveTo`
  is an instruction a client carries out by joining, and this bot deliberately
  has no handler for it: the server refuses a move whose target is a bot, so the
  instruction is never sent. Do not add one. ADR-0010 records what each half of
  a move would do — arrive in a room nobody there asked it into, or destroy that
  room's Queue from a control that never mentioned one. It is also why nothing
  can put this bot in an AFK room.
- An eviction — `voice:forceLeave` — ends the Set, because holding one for a
  membership the server has dropped leaves peer connections open and makes the
  next Summon play into nothing.

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
- **Everything that moves the Queue past a Track names that Track**, and an
  event naming an entry the Queue is no longer on changes nothing and succeeds.
  That is the whole answer to two members skipping at the same moment — no lock,
  no sequence number, nothing to reconcile — and it is why a stale request is not
  a refusal: the member asked for that Track to stop playing and it has. Nothing
  is published either, so every client keeps showing what the bot shows. Read
  ADR-0006 before adding a Queue action that is not an addition.
- **A Track ending is targeted too.** The player reports the end of the Track it
  was handed, and that report waits its turn in the same chain as the commands,
  so a skip can get there first. `load` carries the entry it loads and `music.ts`
  remembers it for exactly this — an untargeted end would drop the Track the skip
  had just started.
- **A skip only ever moves past the head; a removal takes the entry it names
  wherever it is.** Both would be one verb otherwise, and the difference is what
  stops a panel one message out of date turning a Skip press into the deletion of
  a Track somebody is still waiting for.
- **Advancing keeps `playing` as it was.** Skipping says which Track, not whether
  to play, so a paused Queue that advances stays paused — with the new head
  loaded, so resuming plays it rather than the Track that was skipped.
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
- **The Set log is written where the Queue changes, and nowhere else.** A line
  is appended in the branch that makes the change, below the guard that returns
  early — so a stale skip, a pause at an already-paused Queue, a removal naming
  an entry that has gone and an addition refused for a full Queue all write
  nothing, because none of them changed anything or told the room anything. No
  line may describe a change the room was not sent. A Track ending writes none
  either: the log names who did something and nobody did that. Read ADR-0008
  before adding a verb to it.
- **A line's identity arrives on the event**, as `entryId` and a resolved Track
  already do, because this module has no clock and no `crypto`. It carries no
  time at all — ordering is the list's and identity is `lineId`'s — so nothing
  here should acquire a `Date.now()` in order to write one.
- **Every verb carries the member who asked.** `music.ts` used to keep
  `requestedByUserId` for an addition and drop it for the rest; each of the five
  now names the member who asked for *that* action rather than the one who
  queued the Track it happened to.
- **The Set log is bounded** (`musicSetLogMaxLines`) and drops its **oldest**
  line, which is the opposite of what a full Queue does. A Queue is a promise
  about what will play, so the member who would lose their Track is refused; a
  log is a record of what already happened, and the part worth keeping is the
  recent part.
- **A Track that will not play is the fourth targeted event**, not a second way
  to move the Queue. `failed` goes through `advancePast` beside `ended`,
  `skipped` and a head `removed`, so one that names a Track a skip already moved
  past changes nothing and succeeds — ADR-0006's rule, unchanged. It carries
  `playerStillSounding` like a skip and unlike an end: the fetch died, but the
  player may still be sounding whatever arrived before it did. It keeps
  `playing` as it was, so a paused Queue whose head will not play advances and
  stays paused.
- **The failure line names no member, and the reason is the verb.** Nobody did
  this, so the actor is `null` rather than the bot's own account — "Music bot
  skipped Nocturne" reads as somebody having pressed something, in whatever the
  operator called the account. The three verbs are `failedUnavailable`,
  `failedSource` and `failedBot`, each one whole sentence per language, because
  a reason substituted into "a Track failed" is the fragment-stitching ADR-0008
  §5 refuses. This is the one line in the log the bot writes about itself. Read
  ADR-0011 before adding a fourth kind of failure.
- **`playback.ts` never sees a source's words.** The reason arrives on the event
  as an already-decided verb, exactly as an `entryId` and a resolved Track do.
- **The Queue is bounded** (`musicQueueMaxEntries`) because it is broadcast
  whole on every change. Ask `additionRefusal` before spending a link on the
  extractor; do not write a second bound beside it. Ask it only about the Queue
  the Track would actually join — a paste into a *different* room summons the
  bot away and takes the old Queue with it, so pre-checking the one that is
  about to stop existing refuses a member for somebody else's full evening.
- The Queue lives in memory and dies with the Set. Not persisted, by design.

The Grace period is a rule here and a clock in `music.ts`, because this module
is not allowed one. Read `docs/adr/0009-the-bot-waits-and-silences-itself.md`
before changing when the bot leaves.

- **Two events in, two effects out.** `roomEmptied` and `listenerReturned`
  against `startGracePeriod` and `cancelGracePeriod`; `awaitingReturn` on
  `PlaybackState` is the whole of the wait as a module with no clock can hold
  it — *that* one is on, never how long is left of it. Name a new effect after
  the product's word, as `startGracePeriod` is named after `CONTEXT.md`'s term
  and not after the timer that carries it out.
- **The wait does not pause anything and publishes nothing.** A member who comes
  back inside it must find the music *continuing* rather than resumed, and there
  is nobody in the room to publish to. No line is written either: nobody did
  anything, and there is no publish for a line to ride on (ADR-0008). The
  republish a returning member needs is the roster change they cause.
- **Both events are idempotent**, because the hook reports every roster change
  rather than only the interesting ones. A second emptying is the wait already
  running — restarting it would let an empty room hold the bot for as long as
  anything kept moving — and arriving at a room that had people in it cancels
  nothing.
- **An expiry a returning Listener already cancelled changes nothing.**
  `clearTimeout` cannot un-fire a callback the runtime has picked up, so
  `music.ts` asks `awaitingReturn` before ending anything. That is ADR-0006's
  answer for a stale skip, said about a wait instead of an entry — and it is why
  the state carries the flag rather than the timer handle being the only truth.
  Do not reduce the expiry's guards to that one: the room can empty, fill and
  empty *again* while an expiry is queued, and `awaitingReturn` is then true and
  about the **next** wait. Which wait is the clock's knowledge, so `music.ts`
  numbers them; dropping that check ends a Set up to five minutes early.
- **The Queue moving does not end the wait.** A Track playing out in an empty
  room is the Queue advancing, not somebody coming back, so every branch that
  builds a state carries `awaitingReturn` through explicitly.
- **Grace expiry is a new trigger for `endCurrentSet()`, not new clearing.**
  There is no `graceExpired` event and no `leave` effect: ending a Set is
  described in one place, which already discards the Queue and the Set log and
  publishes the empty Queue before the membership goes. A second description
  would drift, and the drift would be a Set that ended without telling the room.

The clock lives in `music.ts`, with the five minutes.

- `gracePeriodMs` is a constant, not an operator value: it is a product decision,
  nothing on the wire mentions it, and no deployment has asked for a different
  number. `setTimeout` is injectable for the same reason the player's interval
  is — a test that waited five real minutes out is a test nobody runs.
- The expiry goes through the **same chain** as a command, because ending a Set
  is several round trips and must not land halfway through a Summon. It then
  asks two questions that are not the same one: has the Set been replaced, and
  is the wait still on.
- `onListenersChanged` carries the room's Listeners, and **the bot is not among
  them**. The Set takes itself out, because it is the only thing here that knows
  which member it is; the bot is an ordinary member of its own voice room, so a
  roster handed through unchanged would report a Listener for a room everybody
  has left.

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
- **The Set log rides that same payload** rather than one beside it. Every line
  is produced by a change that was already publishing the Queue, so a second
  message would buy nothing and cost the one failure this contract prevents: a
  room told that a Track was skipped while still holding it. It is also what
  makes the log arrive with a newcomer's Queue, and what takes it off five
  panels when the empty Queue is published before the bot leaves. ADR-0008.
- **The log dies with the Set, and nothing writes it down.** It is a field on
  `PlaybackState`, so `emptyPlayback()` is the whole of "cleared when the bot
  leaves". The bot has no database, no file it opens and no HTTP surface to
  write through, and `playback.ts` performs no I/O — those are where "never
  written to the database or to any file" is enforced, rather than merely not
  violated.

## Sources and Fetching

Read `docs/adr/0004-fetched-audio-path.md` before changing how a link becomes
audio. What it settles, in short:

- **Resolvers and the audio provider stay separate.** A resolver turns input
  into the identity of a Track; the one audio provider turns that identity into
  a stream. A future Spotify link is a resolver — its terms forbid it ever being
  a source of audio. There are two resolvers now, a pasted link and a typed
  name, and a third would be a third branch in `resolverFor` rather than a new
  verb, a new event or a new subsystem.
- **The bot decides whether an input is a link or a name, and nothing else
  does.** `add` carries one field. `resolverFor` reads it: `http(s)` and not one
  video on YouTube is `unsupported_link`, because somebody who pasted a Spotify
  link wants to hear that their link is wrong rather than see YouTube results
  for the text of a URL; no scheme gets `https://` tried in front of it through
  the same exact-host check; anything left is a name. Only `https?` counts as a
  link — a looser scheme test reads "Beethoven: Symphony No. 5" as a URL.
  ADR-0007.
- **A search Summons nothing, and has a chain of its own.** It changes no Set,
  no Queue and no membership, so it does not queue behind a Summon — otherwise a
  Skip waits out somebody else's ten-second search — and it must never end a Set
  when it fails, which is what that chain's recovery would do. If the bot is
  playing in another channel, Summoning to answer a question would cost that
  room its Set. But it is still serialised **among searches**, because it spawns
  an extractor and two of those at once against a source that rate-limits by
  address is the thing this feature refuses everywhere else. Do not collapse the
  two chains, and do not remove the second one.
- **A Result is answered to one member and published to nobody.** It rides the
  acknowledgement back to the socket that asked. Nothing about it goes near
  `music:publish`; the Queue rule beside it is the opposite rule and ADR-0007
  records why.
- **A search asks for a flat listing** — one request that returns what the
  search page already knew, not a full extraction per result, which would be
  five round trips against a source that rate-limits by address for four Tracks
  nobody will play. A chosen Result is then resolved properly through the link
  path, because a flat entry is not evidence that a Track is playable.
- **Ask the source for more than will be shown.** A live stream or a premiere
  among the hits is not a Result and gets dropped, so asking for exactly
  `musicSearchResultsMax` hands a member three — or, for a name whose every hit
  is a broadcast, "nothing matched" for something that plainly did. It is the
  same one request either way, and `parseSearchResults` stops at the bound.
- **An input with nothing in it is a search that found nothing**, not a wrong
  link. The panel will not send one, but the server bounds the field before
  trimming, so a field of spaces arrives — and no process is spent asking the
  source about no characters.
- **Blame nothing on the video when there is no video.** A failed search is
  `extractor_failed` or `bot_failed`; `classifyExtractorFailure` answers "was it
  the video or the extractor", and a query has no video to be unavailable.
- **A fetch that gave up says so, and `classifyFetchFailure` decides what it
  says.** Ending the buffer is exactly how a completed Track ends, so a failure
  that only did that was invisible to the room — that was ticket 13's bug. The
  rule is pure and lives in `track.ts` beside `classifyExtractorFailure`, which
  it **calls**: whether the source's words blame the video or the source is one
  question with one answer, asked before the bot joins or an hour later when the
  Track's turn comes. Do not write a second phrase list. `stream.ts` gathers the
  evidence and decides nothing.
- **A cancel is not a failure.** Every advance kills the fetch behind the Track
  it moved past, so a teardown that reported itself would put a line in front of
  the room behind every skip. `cancelled` is set before `finish` and is the
  first question the rule asks, because it explains every other signal.
- **Report the failure before closing the buffer.** Closing it is what lets the
  player reach the end and report it, through the same chain — so a failure
  reported second names a Track the Queue has already moved past, does nothing
  by ADR-0006's rule, and leaves the room with the silence and no explanation.
  The order is the whole guarantee; there is no lock.
- **A silent fetch is a failure even with nothing to show for it.** `finish()`
  runs on the *encoder's* exit and the extractor's exit code and stderr may both
  still be in flight, so "no audio ever arrived" is the one signal that cannot
  race. It answers `failedBot` — "check the logs" — rather than blaming a source
  nothing has accused.
- **A search that matched nothing is a success carrying an empty list.** Nothing
  failed and there is nothing for a member to wait out, so the panel puts a
  sentence to it rather than the wire carrying a refusal.
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
  `bot_timeout` in place of the reason it actually gave up. `searchTimeoutMs` has no join to leave
  room for, because nothing follows a search — but the margin has to hold **two**
  of it, because a search that arrives while another is running waits out both.
  It is shorter than a resolve because a flat listing does no per-video
  extraction, so a search that has not answered by then is not one that is
  nearly finished.

## Deployment

The bot has its own image and its own Compose service, and
`docs/adr/0012-the-music-bot-ships-as-its-own-service.md` records why each of
those is a separate thing rather than a flag on the application's. Read it
before changing the Dockerfile's `bot` stage or the `bot` service.

- **The two binaries come from the image, and the image pins them.** yt-dlp is
  installed at `VOXLY_YTDLP_VERSION`, passed through from Compose so an operator
  can raise it without editing the repository; ffmpeg comes from the
  distribution, fixed by the base image tag. The build then runs `yt-dlp
  --version` and greps `ffmpeg -encoders` for `libopus`, because an encoder
  without it fails at the first Track rather than at start-up.
- **Nothing updates itself.** The read-only root is not relaxed so that yt-dlp
  can fetch its own new version, and a Compose change that makes the bot's
  filesystem writable to work around a fetch problem is fixing the wrong thing.
  A new extractor arrives by rebuilding.
- **`/tmp` is scratch for yt-dlp, not room for a Track.** The audio path is a
  pipe and nothing is written to disk (ADR-0004), so the tmpfs is sized for the
  extractor's own use. If a change ever needs it sized for audio, the thing that
  changed is the audio path, and that is an ADR rather than a bigger number.
- **The service is opt-in, behind the `music` profile.** A deployment that
  leaves `VOXLY_BOT_TOKEN` blank is supported and documented, and an always-on
  service would restart-loop in front of those operators forever. Do not make
  the token a required Compose variable to catch it earlier: interpolation runs
  before profile filtering, so it fails `docker compose config` for everybody.
- **Keep the hardening shape identical to `app` and `coturn`** — `read_only`,
  `tmpfs`, `no-new-privileges`, `pids_limit`, and `mem_limit`/`mem_reservation`
  as `${VOXLY_*}` with defaults. `init: true` is not decoration here: two
  subprocesses per Track are killed mid-sentence by every skip.
- **The bot has no healthcheck and should not grow one** that proves only that a
  Node process exists — a bot failing to authenticate for an hour would pass it.
  What it reports instead is its log, which names the value that is missing or
  rejected.
- **Configuration faults stay fatal and everything else stays survivable.** The
  container restarts on exit, so a bot that exits on a dropped connection turns
  a blip into a restart loop; a bot that stays up on a missing token hides the
  one sentence that explains it.

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

For a deployment change, also validate the Compose files that now carry the bot,
with the profile enabled so that the service is actually rendered:

```sh
docker compose --profile music config --quiet
docker compose -f compose.yaml -f compose.turn.yaml --profile music config --quiet
docker compose -f compose.external-proxy.yaml --profile music config --quiet
```

None of that runs a binary. **Nothing in this repository has ever run yt-dlp or
ffmpeg** — not the test suite, not CI, not the machine the image was written on.
Pinning them into an image is what makes the end-to-end check below reproducible
for somebody with a Docker daemon; it is not that check.

For an end-to-end check, start a server with `VOXLY_BOT_TOKEN` set, then run the
bot with the same token and `VOXLY_SERVER_URL`; the Music account appears online
in that server's member list. **yt-dlp and ffmpeg must be installed and findable**
— nothing in the test suite needs them, and nothing in the test suite proves the
fetch works either. Join a voice channel in a browser, paste a YouTube link, and
press the button:

- the bot joins, its row lights, and the Track you pasted is what plays;
- a dead link, a playlist and a live stream each produce their own sentence,
  and none of them puts a silent bot in the channel;
- **a typed name returns results that are actually the song** — this is the one
  nothing in the repository has evidence for, because no query has ever been put
  to a real yt-dlp from here. Check that each result has a length and a channel,
  that a live stream is not among them, and that choosing one plays that Track
  and not another;
- pausing stops the sound and resuming carries on from where it stopped rather
  than starting the Track again;
- a skip moves to the next Track, and two browsers pressing it at the same
  moment cost one Track between them;
- **the Set log says the same thing in both browsers.** Each of the five verbs
  produces a line naming the member who pressed it, the second of two
  simultaneous skips produces *no* line, and sending the bot away empties the
  log on every panel at once rather than only on the one that pressed;
- **a Track that will not play is skipped by itself, with the reason in the
  log.** Queue two Tracks, make the first one fail its *fetch* rather than its
  resolve — the honest way is a link that resolves and whose media is refused,
  which nothing in this repository has yet reproduced on purpose — and the room
  should hear the second Track start and read one line naming the first and no
  member. Nothing about this has been seen against a real yt-dlp;
- **an owner's mute stops the sound**, not just the bot's row: mute the Music
  account from the member list while a Track is playing and the room goes quiet,
  and unmuting carries on from where it stopped rather than restarting the
  Track. This is the one the ticket 03 spike found broken and **no person has
  heard it work**;
- **the Queue survives a reload**: refresh the only browser in the channel and
  come back inside five minutes to find the same Queue, still playing, from
  where it got to. Leave the channel and stay away, and the bot leaves by itself
  with every panel's Queue and Set log emptied;
- it is *clear* — no stutter, no metallic edge, and no gap where the fetch had
  to catch up. A skip is the easiest way to hear a Track boundary on demand, and
  how long that gap runs to is the measurement `The Queue` above is waiting for.

That last one still needs a person and headphones, and no test replaces it.
