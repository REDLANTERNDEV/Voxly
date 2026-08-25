# ADR-0006 — Transport controls name the Track they mean

- **Status:** accepted; §3 amended by ADR-0009
- **Date:** 2026-08-25
- **Context:** ticket 09, "Play, pause, skip, remove"

> **Amendment (ticket 12, ADR-0009).** §3's first supporting fact — that an
> owner's mute does not necessarily stop the bot's packets — is no longer true:
> the bot enforces its own silence. The decision is unchanged and now rests on
> §3's remaining reasons plus a new one, that a muted bot's Queue really is
> running, so Pause still means something. §3's consequence for the panel's
> resting sentence changed with it; ADR-0009 §8 records both.

## Context

The Queue arrived in ticket 08 with one thing anyone could do to it: add to the
end. Everything else the design promises — pausing, resuming, skipping, taking a
Track back out — changes a list that five people are looking at, from five
browsers, at the same time. Two of those actions are destructive, and the design
names the case it cares about: *"two people pressing skip at the same moment to
skip only one Track, so that a coincidence does not cost us a song."*

That is a concurrency problem with an obvious wrong answer. The bot already
serialises everything through one promise chain, so the two skips do not
interleave — but serialising them does not help, because both of them are
correct requests that arrive one after the other and both of them say "advance".
A lock does not help either: neither request is waiting on the other. What is
actually wrong is the *instruction*. "Advance" is a request about a position,
and a position means something different by the time the second one lands.

Three further things had to be settled with it, and each is expensive to change
afterwards because the panel, the wire and the player all rest on them: whether
a skip and a removal are one verb or two, which of two existing answers to "is
the music playing" the controls read, and what a Queue that is paused does when
somebody skips.

## Decision

### 1. Skips and removals name an entry, and a stale one succeeds

`MusicCommand` gains `{ kind: "skip"; entryId }` and
`{ kind: "remove"; entryId }`. `entryId` already existed and nothing used it:
it is minted per addition, so two members queueing the same link are two
entries.

The rule in the Queue is that an event naming an entry the Queue is no longer on
**changes nothing and succeeds**. Two members press skip, both naming the Track
they can see playing; the first advances, the second arrives to find that Track
gone and does nothing. One Track, no lock, no sequence number, and nothing that
has to be reconciled afterwards.

It succeeds rather than being refused because the member asked for that Track to
stop playing and it has stopped playing. A refusal would put a sentence in front
of somebody who got exactly what they wanted, and there is no action for them to
take. Nothing is published either, which is the other half of "an action the bot
rejects leaves every client showing the same state as the bot": the Queue did not
change, so the room is not told it did, and the panel that pressed the button was
already right.

The alternative was to have skip mean "advance", serialised. Rejected: it is the
bug, dressed as an implementation detail. The other alternative was a per-Set
sequence number that a client echoes back, refusing anything stale. Rejected —
it answers the same question with a second identifier, and it refuses the second
skipper for a coincidence rather than agreeing with them.

**A Track ending is targeted the same way.** The player reports the end of the
Track it was handed, and that report waits its turn in the same chain as the
commands; a skip can get there first. An untargeted "the Track ended" would then
advance past the Track the skip had just started, and the room would lose a Track
nobody touched. So `load` carries the entry it is loading, the imperative half
remembers which entry the player is holding, and the end names it. Ending,
skipping and removing the head are then one rule with three names.

### 2. Two verbs, not one

Removing the head is exactly skipping it, so one verb would have done. They are
kept apart because they mean different things when the panel is out of date, and
that is the only time either of them is interesting.

A skip only ever moves past the **head**. A removal takes out the entry it names,
**wherever it is**. So a member whose panel is one message stale presses Skip and
skips nothing; if Skip were "remove the entry I can see playing", that same stale
press would delete a Track somebody else was waiting for. Making the Skip button
structurally unable to reach past the head is worth one extra member of the
union. It also leaves the Set log (ticket 11) able to say which of the two
happened, which one verb could not.

### 3. The controls read the Queue, not the bot's `speaking` flag

Two answers to "is the music playing" existed side by side after ticket 08:
`MusicQueueState.playing`, which the Queue rows read, and the bot's `speaking`
flag on the voice snapshot, which the Play/Stop button derived from. The
transport controls read the Queue, and `speaking` is no longer consulted by the
panel at all.

They can disagree, and each way it happens is a wrong button:

- The server clamps `speaking` to false for a member an owner has muted. Media
  is peer-to-peer, so the mute does not necessarily stop the bot's packets — the
  music can be running, and audible, while the flag says otherwise. The button
  would offer Play for a Queue that is already playing, and pressing it would do
  nothing.
- They arrive in two separate messages, so there is always a window where one
  half of the panel has moved and the other has not.
- `speaking` answers a different question. A stalled player is still playing its
  Track (ADR-0004) and deliberately does not report `speaking: false`; anything
  that later changes how the bot derives that flag would silently invert a
  control that has nothing to do with it.

Reading the Queue also means Play, Pause, Skip and every row's Remove come out of
one message the bot published through the authorized path, so they move together
and none of them can contradict the list they sit under. Skip needs the Queue
anyway — it has to name the head — so the controls were already a function of it.

The mute does not disappear from the interface: it stays as the panel's resting
sentence while the Queue is playing, because a room where the Queue says it is
playing and an owner has muted the bot is a room that needs explaining. It is
information, not the polarity of a button — and it is said only in the state
where it explains something and where the control it names is on offer.

### 4. Advancing keeps the Queue's playing state

Skipping or removing the Track at the head of a **paused** Queue advances it and
leaves it paused. Skipping says *which Track*, not *whether to play*, and
somebody who paused the music to talk should not have the next Track start under
them.

The next Track is still loaded, though — the fetch begins even while paused — so
resuming plays the Track that is now at the head rather than the one that was
skipped. The alternative, deferring the load until the resume, would have needed
the Queue to carry a second piece of state saying whether the head was loaded
yet, and the failure when that state was wrong is the room hearing the wrong
Track.

### 5. The player no longer replays a Track that finished

`TrackPlayer.start()` used to play a finished Track again from its beginning, on
the grounds that a Play button which did nothing would look broken. The Queue
took that argument away: what follows a Track is the Queue's answer, the Queue
loads whatever it wants played, and the button is now disabled when there is
nothing queued. A `play` for audio the Queue did not just load can only be a
mistake somewhere above — and replaying on one puts the *wrong Track* in front of
the room, which is a worse failure than silence and a far harder one to
recognise. Loading a Track still clears it, so every real advance still plays.

## Consequences

- Every Queue-changing action a member can take is idempotent under repetition
  and safe under a stale panel, without the browser holding a version of
  anything. The panel remains a pure function of the last published Queue.
- The Queue's rules stay in `apps/bot/src/playback.ts` and are asserted without a
  socket, a subprocess or a peer connection — including both halves of the race,
  which are ordinary two-line tests because the events are values.
- Adding a Queue action costs a member on `MusicCommand`, a branch in the
  server's validator (which the build already forces), an event in the pure
  module, and a button. There is nothing to coordinate.
- A future reordering feature inherits the targeting for free — it names entries
  — but will have to decide what a move that races another move means, which
  this does not answer.
- The server bounds `entryId` with `musicIdentifierMaxLength` and otherwise does
  not interpret it. It cannot: which entry is at the head is the bot's knowledge,
  and a second opinion here would refuse requests the bot would have succeeded
  at.

## What is not settled here

Whether a Track boundary is audible as silence, and how long for, is still
unmeasured — `apps/bot/AGENTS.md` carries that with its reasoning, and a skip is
now the easiest way to produce one on demand. A Track that fails mid-playback is
ticket 13 and will be another event through the same targeted path. The Set log
is ticket 11, and it is what will let the room see *that* somebody skipped
rather than only hearing the result.

**Both arrived.** The Set log is ADR-0008. A failed Track is ADR-0011, and it is
the fourth event through this path exactly as expected: it names the entry it
means, and one that arrives about a Track the Queue has already moved past
changes nothing and succeeds. It is also the second way to produce a Track
boundary on demand, and the only one that does it without anybody pressing
anything — which is now the easiest way to take the measurement above.
