# ADR-0009 — The bot waits for a return it cannot time, and silences itself

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** ticket 12, "Leaving properly"

## Context

Two unrelated-looking things end this feature, and they turn out to be the same
shape twice: something outside the bot changes, and the bot has to decide what
that means for audio nobody else can stop.

The first is leaving. Until now the bot leaves only when a member sends it away,
is evicted, or is summoned elsewhere — so a room everyone has left keeps a bot in
it forever. The design asks for the opposite of a bot that leaves promptly: *"as
a member who reloaded the page, I want the Queue still to be there when I come
back"*. A page refresh takes a member out of the voice room for a second or two,
and the whole point of the Grace period is that the evening's Queue survives
that. So the decision this turns on is not "when does an empty room end a Set"
but **what tells a member who left apart from a member who is reloading** — and
the honest answer is that nothing does, at the instant it happens. Only time
does. Five minutes of nobody is the product's answer, and it is a measurement
rather than a rule.

The second is moderation. `apps/bot/AGENTS.md` has said since ticket 06 that
"the bot must enforce its own silence", and until this ticket that sentence was
half true: `voice:forceLeave` was obeyed and nothing else was. Media in Voxly is
peer-to-peer by design (ADR-0001), so the server never sees the bot's packets
and cannot drop them; its moderation state is *advisory* for audio. The ticket 03
spike watched a bot the server had marked muted keep playing into a browser. An
owner muting the Music bot is design story 30 — *"so that I can stop the music
using controls I already know"* — and a control that does not do what it says is
worse than one that is not offered.

Three things had to be settled with them, and each is expensive to change
afterwards because the pure module's vocabulary, the Set's hook, and the panel's
copy all rest on them: where a five-minute wait lives in a module that is not
allowed a clock, what an expiry that arrives too late does, and which fact the
bot reads to know it must be quiet.

## Decision

### 1. The rule is a state in `playback.ts`; the clock is an effect in `music.ts`

`playback.ts` performs no input or output — no timers, no `Date.now()`, no
awaiting — and that is the property the whole feature's testability rests on. It
cannot measure five minutes. But "the last Listener leaving starts a wait, a
Listener returning ends it" is a rule about the Queue's life, and rules live
there.

So the split is the one ADR-0008 made for a log line's identity, said about time
instead: **what the module cannot compute arrives on the event, and what it wants
done goes back as an effect.** Two events in — `roomEmptied` and
`listenerReturned` — and two effects out — `startGracePeriod` and
`cancelGracePeriod`. `PlaybackState` gains one boolean, `awaitingReturn`, which
is the *whole* of the Grace period as far as a module with no clock can hold it:
that a wait is on, not how long is left of it.

The effects are named after the product's word rather than the mechanism, which
is the rule already in force for `load` meaning "fetch this Track" rather than
"spawn yt-dlp". "Grace period" is the term `CONTEXT.md` agreed; `startTimer`
would have named the library, and swapping `setTimeout` for anything else would
then have reached into a module that has no business knowing what a timer is.

The alternative was to keep the whole thing in `music.ts` — it owns the clock
anyway, and the rule is four lines. Rejected because those four lines are the
ones a test has to hold still: the acceptance criterion asks for Grace period
behaviour covered by state machine tests that do not wait in real time, and that
is the same constraint said from the other end. Every rule below is asserted in
`playback.test.ts` in two lines, because the events are values.

### 2. An expiry has to prove it is still the wait it was

`clearTimeout` cannot un-fire a timer whose callback the runtime has already
picked up. The expiry goes through the same promise chain as every command — it
ends a Set, which is several round trips, and must not land halfway through a
Summon — so there is a real window in which a member returns at the exact moment
the five minutes run out and the cancelled expiry arrives anyway, behind them.

**ADR-0006 already answered most of this about entries**: a skip naming a Track
the Queue has moved past changes nothing and succeeds. The same answer, said
about a wait: `music.ts` asks `playback.awaitingReturn` before ending anything,
so a wait that a return has already cancelled ends nothing, and the state that
made the decision is the state that vetoes it.

That is not quite the whole answer, and the remainder is the interesting part.
The room can empty, fill and empty **again** while the first expiry is queued —
at which point `awaitingReturn` is true and *correct*, but it is the second
wait's, with nearly five minutes still to run. No fact about the Queue can tell
the two apart, because to the Queue they are the same fact. Which wait is the
clock's own knowledge, so the clock counts them: `music.ts` numbers the waits it
starts and an expiry carries the number of the one it belongs to.

So there are three questions before anything is ended, and none of them implies
another — the Set may have been *replaced* (a Summon into another room), the
wait may have been *cancelled*, and the wait may have been *superseded*. Missing
the third one ends a Set up to five minutes early, which looks exactly like the
Grace period not working.

The counter is private to one closure and is not the per-Set sequence number
ADR-0006 rejected: that was an identifier a *client* would echo back over the
wire to have its request refused. Nothing here is on the wire, nothing is
refused, and no member is told anything.

Both events are also idempotent, because the hook that produces them reports
every roster change rather than only the interesting ones. A second emptying is
the wait that is already running — restarting the clock on each would let an
empty room hold the bot for as long as anything at all kept moving — and a
Listener arriving at a room that already had people in it cancels nothing.

### 3. The roster hook carries the Listeners, and the bot is not one of them

`onListenersChanged` carried nothing, and `set.ts` said why: "It carries
nothing, because nothing needs it to." The Grace period is that reason, so it
now carries `listenerUserIds`.

**The bot takes itself out of the list**, in `set.ts`, because the Set is the
only thing here that knows which member it is. The bot is an ordinary member of
the voice room and therefore in its own roster; a hook that handed the roster
through unchanged would report one Listener for a room everybody has left, and
the Grace period would never start. Doing the subtraction in `music.ts` would
work equally well and would put a trap in the one file that must not fall into
it.

It stays a **roster** hook rather than a snapshot hook, which is the property
ADR-0005 established and this ticket leans on harder: a snapshot lands every time
anyone starts or stops talking, so a Grace period keyed on snapshots would be
restarted per syllable, and one keyed on the *last* snapshot would never fire at
all for a room whose last member left silently.

The list is read off the snapshot and **not** from `mesh.listenerUserIds`, which
looks like the same list and is not. That one is who the bot holds a peer
connection for, which is a media fact, and peers are torn down asynchronously —
so at the moment the last Listener leaves, the mesh still has them. A Grace
period started from it would never start at all, because there is no further
snapshot coming to correct it. The two lists answer different questions and only
one of them is about membership.

### 4. Grace expiry is a new trigger for forgetting, not a new kind of forgetting

The expiry calls the same `endCurrentSet()` that a `leave` command, an eviction
and a lost connection call. That path already discards the Queue *and* the Set
log, publishes the empty Queue **before** the membership goes, and only then
tears the Set down — an order ADR-0005 and ADR-0008 both depend on, because a
publish from a member the server has seen leave is refused, and because that one
message is what takes the log off five panels.

So there is no `graceExpired` event and no `leave` effect. Adding either would
have meant a second description of what ending a Set is, in a vocabulary that
already has one, and the failure when the two drifted would be a Set that ended
without telling the room. The Grace period's only new contribution to clearing is
the `cancelGracePeriod` that `cleared` now returns: whatever ended the Set, there
is no room left to wait in.

### 5. The Grace period does not pause anything

`roomEmptied` returns no `stop`, publishes nothing, and leaves `playing` exactly
as it was. A member who comes back inside the wait finds the music **continuing**
rather than resumed, which is what story 26 asks for and what makes a reload
invisible; the Queue does not know the difference between five seconds and five
minutes and must not act as though it did.

Nothing is published either, for the plain reason that there is nobody there to
tell — and, following ADR-0008, no line is written, because no member did
anything and there is no publish for a line to ride on. The republish a returning
member needs already exists: their arrival is a roster change, and roster changes
republish.

### 6. The bot reads the server's conclusion, not its reasons

The bot reads **its own `media.mic`** off the voice snapshot, and stops sending
when it is false.

That is one read for both rules the ticket names, and it is deliberate.
`normalizeVoiceMedia` on the server is the single place where an owner's mute and
the AFK room's forced mute are applied, and both of them come out as the same
fact: this member's microphone is off. The AFK room is not on the snapshot at
all — `VoiceSnapshot` carries a room id and members, not the room's flags — so
`moderation.muted` cannot answer the AFK half of the question, and a bot that
re-derived the rules from the flags would be holding a second opinion that can
disagree with the server's. Reading the conclusion means a future room-level rule
the server invents is honoured by this bot without the bot being changed.

`realtime.test.ts` asserts the server's half of that contract — an owner's mute
reaches the bot as a microphone it no longer has — because the bot's silence
depends on a fact no bot test can see.

### 7. Silence is enforced under the Queue, not inside it

A mute stops the player. It does not pause the Queue.

The Set holds two things apart that used to be one: what the Queue asked for, and
what the player is doing. A mute stops the sound and leaves the Queue running, so
it goes on advancing through Tracks — every one of them silent, not just the one
that was playing when the mute landed — and lifting the mute carries on from
where the sound stopped rather than restarting anything. An owner lifting a mute
is **not** a member pressing Play, so a Queue that somebody had paused stays
paused.

The alternative was to have the mute pause the Queue, so that the panel and the
room agree. Rejected on two counts. It would put words in the owner's mouth: a
mute says "I do not want to hear this", and a pause is a thing five members can
undo with one button — which would make an owner's moderation a suggestion. And
it would make the bot report a state nobody chose, so that a member pressing Play
against it would produce silence and no explanation.

What the room sees instead is exactly what it sees for a person cut off
mid-sentence: the Queue says a Track is playing, and the bot's own row carries
the red, locked, server-authoritative mute.

### 8. This retires a fact ADR-0006 §3 was built on, and the panel's copy with it

ADR-0006 §3 decided that the transport controls read the Queue rather than the
bot's `speaking` flag, and its first supporting bullet was:

> The server clamps `speaking` to false for a member an owner has muted. Media is
> peer-to-peer, so the mute does not necessarily stop the bot's packets — the
> music can be running, and audible, while the flag says otherwise.

**The second sentence is no longer true, and this ticket is what made it false.**
Surfacing that rather than quietly overriding it: the *decision* stands, and it
stands on its remaining two reasons — the Queue and the flag arrive in separate
messages, and `speaking` answers a different question, a stalled player being
still a playing one. It also stands on a new one that replaces the retired
bullet: a muted bot has a Queue that is genuinely running, so Pause is still a
control that means something, and reading `speaking` would offer Play for music
that is playing.

The panel's resting sentence changes with it. `music.muted` read "An owner muted
the bot. Pause it to be sure it is silent" — an instruction to finish a job the
bot now does itself — and reads "An owner muted the bot, so nobody in this
channel can hear it". English and Turkish changed together, as every string in
this product must.

The rule about *when* it is said does not change: only while the Queue is
playing. It used to be said for two reasons — that it explains a silence, and
that it named a control the member could press — and only the first survives.
The first is the whole of it: playing is the one state where the Queue and the
room disagree, and over a paused or empty Queue the silence needs no explaining.

## Consequences

- `PlaybackState` has a field that is not about the Queue. Every branch that
  builds a state now carries it explicitly, which the compiler makes mandatory —
  and which states a real rule at each site: a Queue moving does not end a
  Grace period.
- The bot's silence is a property of the Set rather than of the Queue, so
  `MusicSet.playing` and `MusicQueueState.playing` can now disagree, on purpose.
  The first is "is sound leaving this process", the second is "what did the room
  ask for". Anything that needs the second must not read the first.
- A member who mutes the bot and then reads the Queue sees a Track advancing that
  nobody can hear. That is intended and is what the panel's sentence is for, but
  it is the state a future reader is most likely to mistake for a bug.
- The five minutes are a constant in `music.ts` and not an operator value. It is
  a product decision rather than a deployment one, nothing on the wire mentions
  it, and there is no evidence yet that any deployment wants a different number.
  Making it configurable later is additive.
- Ending a Set is described in exactly one place. A future reason to leave — a
  server shutting down, an operator command — is a call to `endCurrentSet()` and
  nothing else.
- An expiry has to survive being wrong in three different ways, and the only one
  the Queue can answer is the second. Anything that later moves the clock — a
  configurable wait, a wait per room — has to keep all three, and the third is
  the one that looks redundant until it is not.

## What is not settled here

**The AFK room has no live route into it, and this ticket did not build one.**
The silence rule is real and tested, but the only way the bot could be in an AFK
room is an owner moving it there, and the bot does not handle `voice:moveTo` —
the browser client does, and the server's move is an instruction rather than an
act. A Summon into an AFK room is already refused at the door with `afk_room`,
and a room cannot become the AFK room after the fact. So "the Music bot is silent
in the AFK room" is true of the code and has never been true of a running
deployment, because the bot has never been in one.

Whether the bot should follow a move at all was left open here and is now
answered by [ADR-0010](./0010-the-music-bot-is-summoned-never-moved.md): it
should not, and a move whose target is a bot is refused at the server. So the
AFK room's unreachability is deliberate rather than pending.

**Nothing here changes what remains unverified in this feature**, and this ticket
added no evidence for any of it: the yt-dlp/ffmpeg fetch path has never run on a
machine in this project, traffic has never been forced through TURN, no browser
Listener has confirmed anything by ear, and no real query has ever been put to
yt-dlp from this repository. In particular, **no person has heard an owner's mute
silence this bot**; what exists is a test proving the Set stops the player when
the server says its microphone is off, which is the fault the ticket 03 spike
observed, asserted at the seam rather than in a room.
