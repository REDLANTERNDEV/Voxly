# ADR-0010 — The Music bot is summoned, never moved

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** the question ADR-0009 left open under "What is not settled here"

## Context

An owner can move any member between voice channels, and until now the Music bot
was offered in that menu like anyone else. Three files said so in as many words —
`bots.ts`, `memberDirectory.ts` and both applications' `AGENTS.md` — on the
reasoning that "muting, deafening, disconnecting and moving the bot all mean
exactly what they mean for anyone else, and the bot honours them."

It did not honour them. A move is not something the server performs; it cannot
be, because the client owns the peer connections and the capture, so
`moveMember` **emits an instruction** — `voice:moveTo` — and the browser carries
it out by joining the target room. The Music bot has no browser. `socket.ts`
narrows its connection to join, leave, media state, RTC signalling and
`voice:forceLeave`, and `voice:moveTo` is not among them, so the instruction
lands on a process with no handler for it.

The visible result is a menu entry that does nothing. The invisible one is
worse: the route answers `204`, and writes a `voice.moved` audit row for a move
that never happened.

ADR-0009 made mute and disconnect real for the bot and left this deliberately
open, on the grounds that "a move is not an eviction, so ending the Set is too
strong, but carrying the Queue into the new room raises what a move means for
five people watching a Music panel". This settles it, and the answer turned out
not to be either of those.

## Decision

### 1. Both halves of a move break a rule that already has a reason

A move is a departure and an arrival. Taken separately:

**The arrival puts the bot in a room nobody there asked for it.** Every Set the
bot has ever played exists because a member *inside that voice room* asked for
one: `music:control` is authorized against live voice membership, and
`apps/server/src/music.ts` says why — "Being in the room is the whole permission:
it is what makes this the asker's room to change." A move is not checked that
way and cannot be; `moveMember` does not require the owner to be in the target
room at all. Honouring the arrival would make the move the one path into a voice
room that skips the door every other path goes through.

For the AFK room specifically it is worse, because the product already refuses
this exact outcome in as many words. A Summon into an AFK room is turned away
with `afk_room` and the reason is written beside it: "a bot summoned there could
only ever be a silent participant. Refusing at the door is clearer than joining
and going quiet." A move into the AFK room *is* joining and going quiet.

**The departure destroys the Queue, from a control that never said so.** Leaving
a voice room ends the Set — that is what a Set is — and ending a Set discards the
Queue and the Set log and publishes an empty Queue to the room (ADR-0005,
ADR-0008, ADR-0009 §4). So a menu entry called "Move to" would silently take
away an evening's Queue.

That is precisely the failure ADR-0006 §2 spent an extra union member avoiding,
when it kept Skip and Remove apart so that a stale Skip could not delete a Track
somebody was waiting for. **Destructive under a non-destructive label is the
worst kind of wrong**, and it is much worse than a control that does nothing:
nothing is confusing, and this is unrecoverable.

The room left behind would also get no explanation. The Set log dies with the
Set, so five people would watch the Queue empty with no line saying why — which
is the failure ticket 11 exists to prevent.

### 2. Carrying the Queue across rooms is not available either

The remaining option — move the bot *and* take the Queue with it — contradicts
the glossary twice. `CONTEXT.md` defines a Queue as belonging "to the voice room
it was summoned into", and a Set as "the stretch from a Summon until the Music
bot leaves the voice room". A Set that survives leaving a room is not a Set, and
a Queue that changes rooms is not that Queue.

It also does not fix the two problems above; it only moves them. The arriving
room still never asked, and now it is handed a Queue built by people who are not
in it, while the room that was listening loses one with no explanation.

Renaming two glossary terms to buy a worse outcome is not a trade worth making.

### 3. So the action does not apply: refused at the server, withheld in the browser

`rejectBotTarget` now covers the move route, alongside kick, ban, the invite
grant and access-link creation — the actions that presuppose a person. The
browser's `canOwnerModeratePerson` (renamed from `canOwnerModerateMembership`,
because the set it describes is no longer only about membership) withholds the
menu entry in both sidebars.

Both, not one. The client hiding a control is presentation and never the
enforcement — `AGENTS.md` is explicit about that — and the server refusal is what
keeps the audit trail honest. `cannot_moderate_bot` is the existing sentence and
needed no new one; the browser does not surface it, because it never asks.

**Nothing changes in `apps/bot`.** That is the sign the decision is in the right
place: the bot already ignores `voice:moveTo` by never subscribing to it, and
after this it ignores an instruction that is no longer sent. A rule enforced by a
handler the bot would have to remember not to add is a rule waiting to be
un-enforced.

### 4. Everything an owner wants from this already exists, and says what it does

- *"Stop the music in here."* The Music panel's own send-away, or Disconnect, or
  — since ADR-0009 — Mute, which now really does silence it.
- *"Play in that channel instead."* Paste a link there. That is a Summon, it goes
  through the door, and the Queue it builds belongs to the room that built it.

A move adds only the ability to reach a state nothing else in the product
produces: the Music bot in a room nobody in it sent for.

### 5. The AFK room stays unreachable, and that is the answer

ADR-0009 recorded that its silence rule had no live route, because a Summon into
an AFK room is refused, a room cannot become the AFK room after the fact, and the
bot could not be moved into one. This closes the third of those deliberately
rather than opening it.

The silence rule stays, and it is not dead code: it reads the bot's own
`media.mic`, which is the server's conclusion rather than its reasons, so the bot
honours *any* room-level rule the server invents without knowing the rule exists.
The AFK room is the one such rule today. Being unable to reach it by moving the
bot is a property of this decision, not a gap left by it.

## Consequences

- The Music bot's relationship to a voice room has one direction: it is summoned
  in by somebody inside, and it leaves — sent away, evicted, or by the Grace
  period running out. Nothing pushes it sideways. Any future feature that wants
  to relocate it is a Summon, and has to answer to the same door.
- `voice:moveTo` remains a browser-only instruction, and the bot's socket surface
  stays as narrow as `socket.ts` describes it.
- The owner's voice menu now splits three ways rather than two: mute, deafen and
  disconnect for anyone; kick, ban, invite grant, access link **and move** for a
  person; volume and rename for whoever they apply to.
- The four places that claimed the bot honours a move are now correct. That claim
  had been wrong since the bot's first Set, and nothing failed because of it — a
  reminder that a sentence in an `AGENTS.md` is not a test.
- An owner who expects to move the bot finds the entry absent rather than
  present-and-broken. They are not told why; the product does not explain the
  absent kick and ban entries either, and a menu that argues with the reader is
  worse than one that is simply shorter.

## What is not settled here

**Whether the bot should be able to follow a member between rooms at all** — a
"bring the music with me" feature — is a different question from moderation and
is not answered here. It would be a Summon by the member who moved, made from
inside the room they arrived in, and the interesting part of it is what happens
to the room they left rather than anything in this record.

Nothing here changes what remains unverified in this feature: the yt-dlp/ffmpeg
fetch path has never run on a machine in this project, traffic has never been
forced through TURN, no browser Listener has confirmed anything by ear, and no
real query has ever been put to yt-dlp from this repository. This decision adds
one more thing that has never been observed in a running deployment, and it is
the point of the decision: **the Music bot has never been in an AFK room, and
now it cannot be put in one.**
