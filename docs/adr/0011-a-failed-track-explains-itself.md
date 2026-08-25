# ADR-0011 — A Track that will not play says so itself, in the verb

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** ticket 13, "When a track won't play"

## Context

A Track that resolved at eight o'clock can refuse to play at nine. The
pre-playback path already answers for the other case and answers it well:
`resolveTrack` asks the source about a pasted link, `classifyExtractorFailure`
decides whether the video or the source is to blame, and a member who pasted a
dead link is told so before the bot appears in the channel at all.

The gap is what happens after that. `fetchTrackAudio`'s `finish()` ends the
buffer, and it ends it **exactly as a completed Track ends it** — `reader.incomplete`
was logged and thrown away. So the player reached the end of a Track that had
delivered nothing, reported `onEnded`, and the Queue advanced. A blocked video
and a Track the room had heard all of were the same event, distinguishable only
by reading the bot's own logs, which nobody in the room can.

Four things had to be settled, and each is expensive to change afterwards
because the wire, the pure module, the adapter and the panel all rest on them:
what a line with no member on it looks like, how the reason crosses the wire,
what actually counts as a failure when two processes end within a tick of each
other, and whether a failure is a second way for the Queue to move.

ADR-0008 named the first of these and deliberately left it open:

> A Track failing mid-playback (ticket 13) will want a line and has no member to
> name. […] the honest answer is probably a line whose actor is the bot rather
> than a person, and it should be designed against the failure it is explaining
> rather than guessed at here.

This is that design, against that failure.

## Decision

### 1. The reason is the verb, not a field beside one

`MusicSetLogAction` gains three members — `failedUnavailable`, `failedSource`,
`failedBot` — rather than one `failed` with a `reason` field next to it.

The alternative is the obvious one and it is wrong for a reason this repository
has already written down. ADR-0008 §5: *"The browser builds the whole sentence in
one translation string per verb, not out of fragments assembled in JSX. Turkish
does not put these words in English's order."* A `failed` verb with a `reason`
beside it puts the reason back into a fragment — "a Track failed" plus a
translated noun phrase substituted into it — which is the same stitching said in
a different place. Turkish does not build "skipped X because the source refused
us" out of an English sentence with a Turkish clause dropped in.

Folding it into the verb also removes a shape that could be wrong. There is no
`reason` that a `paused` line could carry and no `failed` line that could arrive
without one, because neither exists. And it keeps the enforcement that is
already there: `MusicSetLogAction` is closed, the browser's `setLogKey` switch is
exhaustive, and the server's `coversEverySetLogAction` join fails the build for a
verb the validator forgot. **Three verbs is three mandatory English strings and
three mandatory Turkish ones**, checked by the compiler rather than by whoever
remembers.

Three rather than two, which the ticket's fourth criterion asks for and stops
one short of. `failedUnavailable` sends a member to find another Track;
`failedSource` sends the room to wait; `failedBot` sends whoever hosts the server
to the bot's logs. The third is not a shade of either — a fetch spawns ffmpeg,
and an encoder nobody installed is not a blocked video and is emphatically not
YouTube refusing anything. Telling a room to wait that one out is a wait with
nothing at the end of it, which is the failure `apps/bot/AGENTS.md` already names
under *Blame the right thing*. They are the same three answers `MusicCommandAck`
gives a member whose link would not resolve, said about a Track whose turn came.

### 2. The actor is empty, and not the bot's own account

`MusicSetLogLine.requestedByUserId` becomes `string | null`, and is null exactly
for those three verbs.

The tempting alternative needs no schema change at all: the bot knows its own
user id, it is an ordinary member of the voice room, and the browser would
resolve it to a live nickname off the roster it already has. It was rejected
because of what it *renders as*. The five existing sentences read "**Ada** skipped
Nocturne", and a sixth reading "**Music bot** skipped Nocturne" is a sentence about
somebody having pressed something — in whatever the operator happened to call
the account. The room would be told a member acted, which is the one thing this
log exists to be trusted about.

So the failure sentences name no actor at all. "Skipped Nocturne — that video
will not play" is the whole line, and nothing in it asks who. That is what makes
the null safe: the type cannot tie the emptiness to the verb, but no reader ever
reaches for the field, because no sentence has a place to put it.

`music.requesterUnknown` — "someone who left" — is deliberately *not* the answer
either. That stand-in is for a member who really was there and has gone; putting
it in front of a failure would invent a person.

The server validates the field as nullable and does **not** check which verbs may
leave it empty. Which lines the bot writes about itself is the bot's knowledge,
and a second copy of that rule in the validator would refuse a publish the bot
was right to make — losing the room its whole Queue over one line.

### 3. A failure is the fourth targeted event, not a second way to advance

`PlaybackEvent` gains `{ kind: "failed"; entryId; reason; lineId }`, and it goes
through `advancePast` exactly as `ended`, `skipped` and a head `removed` do.

ADR-0006's rule applies unchanged and is the reason this needs nothing new: a
fetch decides it has failed some time after it was started, and a skip can reach
the Queue first. A failure naming a Track the Queue has already moved past
**changes nothing and succeeds** — no line, no publish, no refusal. Ending,
skipping, removing the head and failing are one rule with four names.

Two smaller things follow from putting it there rather than beside it:

- It carries `playerStillSounding: state.playing`, like a skip and unlike an
  end. An end means the player has already stopped itself; a failure does not,
  because the fetch may have died while the player was still sounding whatever
  had arrived. That is what stops the last Track in a Queue leaving the room
  with a player still running.
- It keeps `playing` as it was, like every other advance. A paused Queue whose
  head will not play advances and stays paused (ADR-0006 §4): the failure says
  which Track, not whether to play, and somebody who paused the music to talk
  should not have the next Track start under them because a fetch died.

`playback.ts` still performs no I/O and still knows no source's vocabulary. The
reason arrives on the event as an already-decided verb, exactly as `entryId`, a
resolved Track and a `lineId` already do.

### 4. The failure is reported before the buffer is closed

This is a one-line ordering decision inside `finish()` and it is load-bearing, so
it is written down.

Closing the buffer is what lets the player reach the end of the Track and report
it, and that report travels the same promise chain the failure does. Report
after closing, and the two race: if the end wins, the Queue advances with no
line, and the failure arrives naming a Track the head has already moved past —
where ADR-0006's rule correctly makes it do nothing. The room would be left with
the silence and no explanation, which is the bug this ticket set out to fix,
reintroduced as an ordering accident.

Reporting first makes the chain's FIFO order the guarantee. There is no window
and nothing to reconcile.

### 5. What counts as a failure is a pure rule, and it calls the existing one

`classifyFetchFailure` lives in `track.ts` beside `classifyExtractorFailure` and
**calls** it rather than repeating it. Whether the source's words blame the video
or the source is one question with one answer, whether it is asked before the
bot joins or an hour later. `stream.ts` gathers the evidence; it decides nothing.

That placement follows the rule already at the top of `stream.ts`: what lives
there are argument lists and timeouts, which only the real binaries can judge,
and what can be judged by a test was deliberately put in `track.ts`. *Which of
three things to tell a room* is squarely the second kind.

The order of the questions is the order of certainty. A cancel explains every
other signal, so it is asked first — a skip kills both programs mid-sentence,
and every fact left behind then looks like a failure. Then the bot's own
failures, which are facts rather than readings: a program that could not be run,
and a fetch that ran out of time. Only then is somebody else's stderr matched
against a phrase list. Anything unrecognised comes out as `failedSource`, which
is the same safe direction `classifyExtractorFailure` already takes and for the
same reason: "that video will not play" sends a room to replace a Track that was
never broken.

**The evidence arrives in stages, so the question is asked more than once.**
`finish()` runs on the encoder's *stream* ending, and at that moment neither
program's exit code need have been delivered and the extractor's stderr may
still be in flight. Two different fetches are lost if that is the only moment
the question is asked, and they need different answers:

- **A fetch that produced nothing** cannot wait, because closing the buffer lets
  the player reach the end immediately and §4's ordering is the only thing
  keeping the failure ahead of it. So the outcome carries `silent` — whether any
  playable audio ever arrived — which cannot race, because the buffer is the
  thing that was or was not filled. It is the last question the rule asks and
  the weakest answer it gives: `failedBot`, "the Music bot could not play it",
  which sends the one person who can find out to the logs where the real reason
  is written.
- **A fetch that produced half a Track and then lost yt-dlp** is the one that
  looks most like success and is hardest to catch: ffmpeg reads EOF, closes a
  perfectly clean Ogg stream around the audio it did get, and exits. Nothing is
  `incomplete`, nothing is `silent`, and the only evidence is exactly the
  evidence that may not have landed. So each program is also watched for
  `close` — which waits for its streams where `exit` does not — and the question
  is asked again there, once, with a `reported` flag so a fetch fails only once.
  The late answer is early enough by construction: a fetch with audio in it
  leaves the player minutes to drain and this arrives within a tick.

Without the second of those, `failedExit(encoderCode)` would be nearly
unreachable in production — a branch the tests exercise and the real path never
takes.

## Consequences

- A failure drops audio that was fetched but not yet played. The buffer fills
  faster than realtime, so a mid-download failure at 0:30 of a Track that had
  reached 2:30 in memory costs the room those two minutes — and it is that
  headroom, not luck, which makes §5's second, later answer safe to rely on.
  Accepted rather than overlooked: the alternative is to let the Track play out and attach the reason
  to the end that follows, which reads better in that one case and fails
  completely in another — a **paused** Queue never reports an end, so the failure
  would sit unreported until somebody pressed Play, and a *silenced* bot's player
  is stopped, so it would never report at all. "Skipped automatically" has to
  mean automatically. If a real Set shows mid-download failures are common
  enough to matter, the fix is to let the player drain *and* report at once, not
  to move the report.
- The Set log is no longer only a record of what members did. `CONTEXT.md`'s
  definition is widened to match, and it is the one place in the panel where the
  bot speaks about itself.
- `MusicSetLogLine.requestedByUserId` is nullable for every reader, including the
  five verbs that always have one. The browser is the only consumer that reads
  it, and it reads it in one place.
- Adding a failure kind now costs a member on `MusicTrackFailure`, a branch in
  the server's validator, a branch in `setLogKey`, and two translation strings —
  all four of which the build makes mandatory. There is still no second
  publisher, no second authorization point and no second delivery.
- `stream.ts` grew state it did not have: two exit codes, four flags and a
  retained stderr tail. It is still untested and still by the same argument, but
  the argument now has to stretch one step further than it did: *when* there is
  enough evidence to answer is a decision, it lives there, and only its
  consequence is guarded — in `track.ts` for what the answer is, and at the
  responder seam for what the ordering buys. `apps/bot/AGENTS.md` says so rather
  than leaving the exemption reading as though nothing had changed.
- A member who typed a name and got a Result is now told when that Result will
  not play, which the search path had no way to say. `resolveTrack` still runs on
  a chosen Result, so most of these are caught before the bot joins; this is the
  hour-later case for both resolvers at once.

## What is not settled here

**How long the room hears nothing before the next Track starts.** A failure
produces a Track boundary exactly as a skip does, and how long that boundary
runs to is the measurement `apps/bot/AGENTS.md` has been waiting for since ticket
08. A failure is now the second way to produce one on demand, and the one that
does it without anybody pressing anything.

**Whether a Queue where every Track fails should stop asking.** Ten blocked
Tracks in a row is ten fetches against a source that may be rate-limiting the
bot, and ten `failedSource` lines that push everything else out of a log bounded
at twenty. Nothing here backs off, retries or collapses repeats. It is left
alone because the shape of the fix depends on which of those actually happens to
a real room, and nothing in this repository has watched one yet.

**Whether a silenced bot's Queue should advance at all.** A bot an owner has
muted has a stopped player, so no Track ever reports an end and the Queue does
not move — which predates this ticket and is not changed by it. A failure *does*
now move a silenced Queue, because it does not come from the player. That is an
inconsistency, it is small, and inventing an answer for it here would be
guessing at a case nobody has hit.

Nothing here changes what remains unverified in this feature, and this ticket
added no evidence for any of it: the yt-dlp/ffmpeg fetch path has never run on a
machine in this project, traffic has never been forced through TURN, no browser
Listener has confirmed anything by ear, and no real query has ever been put to
yt-dlp from this repository. The two failure constants this ticket added to
`test/fixtures/extractorFailures.ts` were written to yt-dlp's documented message
formats like every one before them, and were not captured from a live run.
