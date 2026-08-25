# ADR-0008 — The Set log rides the Queue, and only a real change writes a line

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** ticket 11, "The Set log"

## Context

The Queue arrived in ticket 08 and grew controls in ticket 09. Between them they
made a room where five people can change what everybody hears, and left the
result unexplained: the music stops mid-Track and four people have no idea why.
The design names it — *"I want to see that someone skipped a Track, so that I
understand why the music suddenly changed"* — and adds a second story with it,
that actions in a shared room should be attributable.

The panel has just acquired an exception to its oldest rule. ADR-0005 and
ADR-0006 are both built on "everything the panel shows is read from the Queue
the bot published, so five members see one thing", and ADR-0007 carved out the
one thing that is not: a list of search Results, which belongs to the member who
typed and is never published. That exception is the newest rule in this area and
therefore the one the next person reads first — so the first thing to settle is
which side the log falls on.

Three further things had to be settled with it, and each is expensive to change
afterwards because the wire, the pure module and the panel all rest on them:
whether a log line travels on the Queue's payload or beside it, what stops a
line describing something that did not happen, and where a module that performs
no I/O gets an identity from.

## Decision

### 1. The log is the room's, like the Queue and unlike a Result

**ADR-0007 does not apply here, and the reason it does not is the reason it
existed.** A Result belongs to one member because that member has not decided
anything yet, because it is a question rather than state, and because publishing
it would put four other people in front of a choice that is not theirs. A log
line is the opposite on all three counts: the decision has already been taken,
it is a fact about the room rather than a question, and its whole purpose is to
reach the people who did *not* act. "Ada skipped Nocturne" shown only to Ada
explains a silence to the one person who already knew.

So it goes through `music:publish` and `music:queue`, is authorized by the
server exactly as the Queue is, and is bounded and validated at the same door —
the strings in it are the source's, and it is relayed to every browser in the
channel.

### 2. One payload, not two

The log is a field on `MusicQueueState` rather than a message of its own.

The objection to putting it there is real and worth writing down: the Queue is
published whole on every change, and it is bounded (`musicQueueMaxEntries`)
precisely because it is. A log only ever grows, so a log on that payload means
every line re-sends the whole Queue.

It costs nothing, because of *when* lines are written. Every line is produced by
a change that was already publishing the Queue — an addition, a skip that
advanced, a removal, a pause that stopped something. There is no event that
writes a line without publishing, so there is no message here that would not
have been sent anyway. What the field adds is bytes to a message already in
flight, on a payload already bounded twice over.

Two payloads, meanwhile, buy a failure this contract exists to prevent. A room
told "Ada skipped Nocturne" in one message and handed a Queue still holding
Nocturne in another is a room where the explanation and the thing it explains
disagree — for as long as one message is in flight, or permanently if one is
lost. That is the same argument the shared contract already makes for the Queue
travelling whole rather than as a delta, applied to a second thing that
describes the same moment.

It also settles two things for free. The bot republishes when the room's roster
changes (ADR-0005), so a member who walks in mid-Set is handed the log along
with the Queue without a second republish path. And the Queue is published empty
before the bot leaves the room, so *the same message* takes the log off five
panels — which is what makes "the Set log is cleared when the Music bot leaves"
true, rather than a second thing to remember to clear.

`musicSetLogMaxLines` is 20, and the bound drops the **oldest** line rather than
refusing the newest. That is the opposite of what a full Queue does, and the
difference is what the two lists are: a Queue is a promise about what will play,
so the member who would lose their Track is told (`queue_full`); a log is a
record of what already happened, and the part worth keeping when there is not
room for all of it is the recent part. Twenty rather than a hundred because the
panel owns no scroll region (`apps/web/AGENTS.md`) and because of what the log
is *for* — it explains a silence that has just happened, and a log long enough
to need scrolling has stopped answering that question.

### 3. A line is written only where the Queue publishes

This is the rule the whole thing rests on, and it is enforced by *where* the
lines are written rather than by a check beside them: each line is appended in
the branch of `playback.ts` that makes the change, below the guard that returns
early.

ADR-0006 made a stale skip succeed, change nothing and publish nothing. A line
for one would tell four people that a member skipped a Track that nobody
skipped — in a panel that is still showing them that Track playing. The same
question applies to a pause arriving at an already-paused Queue, to a resume
with nothing to resume, to a removal naming an entry that has gone, and to an
addition refused for a full Queue: all of them change nothing, and none of them
writes a line.

Stated the other way round: **no line can describe a change the room was not
told about, and no line arrives without the Queue it describes.** Both halves
come from the same placement.

Two events publish and still write nothing. A Track that ends of its own accord
writes no line, because the log names who did something and nobody did that —
naming the Requester would say they skipped a Track they had queued. And the Set
being torn down writes none, because the log does not survive it to describe it.

### 4. Time and identity arrive on the event, and there is no clock

`playback.ts` performs no input or output — no timers, no `crypto`, no logging —
and a log line needs an identity it cannot mint. So the identity arrives on the
event, as `entryId` and the resolved Track already do: every member-driven event
carries a `lineId`, minted by `music.ts` beside the `entryId` it already mints.

**There is no timestamp**, and that is a decision rather than an omission.
Ordering is the list's, identity is `lineId`'s, and neither needs a clock. What
a rendered time would add is a wall-clock instant from the *bot's host*, which
is not the member's, displayed either as an absolute time that needs locale
formatting or as a relative one that needs a ticking re-render of a block
nobody is interacting with. Nothing in the design asks for one. Adding the field
later is additive and cheap, which is why it is safe to leave out now.

Only `added` carried the acting member before this; `music.ts` dropped
`requestedByUserId` for every other verb. It is now threaded through `apply`, so
each of the five verbs names the member who asked for *that* action rather than
the member who queued the Track it happened to.

### 5. Ids on the wire, sentences in the browser

`MusicSetLogLine.requestedByUserId` is an id, resolved to a nickname by the
browser from the room's members — the same rule and the same reason as
`MusicQueueEntry.requestedByUserId` (ADR-0005). The bot is handed an id with
every request and never sees a member list; a nickname it copied would be the
copy that went stale on a rename. A member who has left is named by the same
stand-in sentence the Queue already uses, because their id would be true and
unreadable.

The line carries the Track as a **title** rather than an `entryId`. The point of
most lines is that the entry has gone, so there would be nothing left in the
Queue to look the id up in.

The browser builds the whole sentence in one translation string per verb, not
out of fragments assembled in JSX. Turkish does not put these words in English's
order, and a sentence stitched together in markup would have to.

### 6. The panel puts it last

The log is the final block in the Music panel, below the transport controls.

Everything in this panel grows the page, because the call surface is the sole
scroll owner. The Queue grows when a member adds something; the log grows on
**every** press anyone in the room makes, including a pause that changes nothing
else on the page. Anything above it therefore drifts down while somebody else
acts — so the thing that grows goes last, and every control's position stays a
function of the Queue alone.

It is not a live region. The panel has one, it belongs to the member waiting for
an answer to their own press, and a second one announcing every other member's
action would talk across it.

## Consequences

- `MusicQueueState` now carries something that is not the Queue. The name was
  kept: it is "the Queue and what is happening to it, as everyone in the room
  sees it", and a rename would ripple through both applications for nothing that
  is hard to reverse later.
- A Queue feature that needs to explain itself costs a member on
  `MusicSetLogAction` and a branch in the browser's mapping, both of which the
  build makes mandatory. There is no second publisher, no second authorization
  point and no second delivery.
- The bot mints two kinds of opaque id per Set — entries and lines — from two
  named minters. In the process both are `randomUUID`; they are separate so that
  a test naming an entry does not have to know which ids the log consumed on the
  way past. They share one bound (`musicIdentifierMaxLength`), because they are
  the same kind of thing to everyone handling them.
- A Track failing mid-playback (ticket 13) will want a line and has no member to
  name. That is a real gap in this vocabulary and it is left open deliberately:
  the honest answer is probably a line whose actor is the bot rather than a
  person, and it should be designed against the failure it is explaining rather
  than guessed at here.
- A member who joins mid-Set is shown lines about things that happened before
  they arrived, with nothing saying how long ago. That follows from having no
  clock, and it is the same trade the Queue already makes: it does not say when
  anything was queued either.

## What is not settled here

**Where "never written to the database or to any file" is enforced**, for the
record, because it is an acceptance criterion rather than an implementation
note:

- The server is the wire and keeps no copy. `publishQueue` validates and emits;
  there is no table for a log line and no code path that looks for one. This is
  asserted rather than asserted-about — `realtime.test.ts` publishes a line
  carrying a marker string, then reads every table named in `sqlite_master` and
  fails if the marker is in any of them. It also asserts that a string the
  database *does* hold is found, so the test cannot pass by looking in the wrong
  place.
- The bot has no persistence at all to write to: no database, no HTTP surface,
  no file it opens (`apps/bot/AGENTS.md`, Boundaries). The log lives in
  `PlaybackState`, which is a value held for the life of a Set and replaced by
  `emptyPlayback()` when it ends.
- `playback.ts` could not write it down if it wanted to. It performs no I/O, and
  that rule is what stops a line ever acquiring a `Date.now()` or a write.

**A Set log cleared on leaving is not the same thing as the Grace period.** The
bot leaving an empty room after five minutes is ticket 12, and what expires
there is the Set. This ticket's clearing is what happens *because* the Set
ended, whoever ended it.

Nothing here changes what remains unverified in this feature, and this ticket
added no evidence for any of it: the yt-dlp/ffmpeg fetch path has never run on
a machine in this project, traffic has never been forced through TURN, no
browser Listener has confirmed anything by ear, and no real query has ever been
put to yt-dlp from this repository.
