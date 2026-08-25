# ADR-0007 — A search is a resolver, and its results belong to one member

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** ticket 10, "Search by name"

## Context

Everything the Music panel could do until now started with a link somebody had
already found somewhere else. Typing a name instead is the design's first story
— *"I want to search for a song by name, so that I can play music without
leaving Voxly"* — and the shape of it is settled: several results, the closest
one already on offer, so Enter takes the obvious answer and a different one can
be chosen when the top result turns out to be a cover or an hour-long mix.

ADR-0004 already said what a search *is*: "a resolver turns input into the
identity of a Track; the one audio provider turns that identity into a stream."
So the media path is not in question here and must not move. What is in question
is four things that are expensive to change afterwards, because the wire, the
bot's request chain and the panel all rest on them:

1. A successful `MusicControlAck` is `{ ok: true; track: MusicTrackSummary | null }`
   — one Track or none, and `packages/shared/AGENTS.md` records that the null is
   deliberate rather than an oversight. Several Results do not fit in it.
2. Something has to decide whether a string is a link to play or a name to
   search for. `isSendableLink` sent anything non-empty and let the bot answer,
   which was right when every non-link was a mistake and is not right now.
3. Results are the first thing this panel shows that is **not** the published
   Queue. ADR-0005 and ADR-0006 both rest on "everything the panel shows is read
   from the room, so five members see one thing", and a list of Results is the
   exact opposite of that.
4. The bot serialises every request through one promise chain, and a search is
   another round trip to somebody else's servers.

## Decision

### 1. One verb carries both, and the bot decides which it is

`MusicCommand`'s `add` changes from `{ kind: "add"; url }` to
`{ kind: "add"; input }`: a link **or** a name, on one field. The bot looks at
it — `resolverFor` in `apps/bot/src/track.ts`, which is pure and covered — and
the answer says which happened.

The alternative was to have the member choose, through two controls or two
verbs, with the browser routing on the string's shape. Rejected on the rule this
contract already holds elsewhere: *which links are playable is the bot's
knowledge*, and a second opinion in the browser is the copy that drifts. "Is
this a link" is not a different question from "is this a link I can play" — both
are answered by the same host list — so splitting them would put half of one
rule in a process that cannot see the other half. Two controls were also worse
for the member, who would have to know which one their string was for before
they had a reason to care.

The rule `resolverFor` applies is small enough to state: anything beginning
`http://` or `https://` is a link, and if it is not one video on YouTube it is
`unsupported_link` rather than a name to search for — somebody who pasted a
Spotify link wants to hear that their link is wrong, not to be shown YouTube
results for the text of a URL. Anything without a scheme gets `https://` tried
in front of it, through the same exact-host check, so `youtube.com/watch?v=…`
typed rather than pasted is still a link and nothing new is recognised. What is
left is a name.

Only `https?` counts as "announces itself as a web address". A looser scheme
test — any `word:` prefix — reads "Beethoven: Symphony No. 5" as a URL, and a
member typing that deserves an answer rather than a refusal.

An input with **nothing** in it is neither, and is answered as a search that
found nothing rather than as a wrong link. The panel will not send one, but the
server's bound is applied before trimming, so a field of spaces does arrive; and
"that link is not a YouTube video" is the wrong sentence to put in front of
somebody who typed no link at all. No process is spent asking the source about
no characters.

**`music.errorLink` was rewritten.** "That is not a link to a YouTube video"
described a world where anything that was not a link was a mistake; it now says
the *link* is not a YouTube video and points at typing a name instead.

### 2. The success acknowledgement becomes a discriminated union

```ts
export type MusicAnswer =
  | { ok: true; kind: "track"; track: MusicTrackSummary | null }
  | { ok: true; kind: "results"; results: MusicSearchResult[] };
```

Both `MusicControlAck` and `MusicCommandAck` take it, so there is one shape for
"it worked" rather than two that drift.

Widening the existing success to `{ track: … | null; results: … | null }` was
rejected for the reason this contract already gives for the *command* union:
two nullable fields where exactly one is ever filled leaves nothing to stop an
answer arriving as both, or as neither, and makes every consumer handle a state
that cannot happen. A separate `music:search` event beside `music:control` was
rejected too — the transport rules do not vary (this room, this instruction,
this bot, this authorization), which is precisely the argument
`packages/shared/AGENTS.md` makes for one event carrying a union.

The cost is that every existing consumer of a successful ack had to be told
which kind it was holding. That is the intended cost: a caller that forgets
there is a second kind of answer should have to say so, exactly as one that
forgets `track` can be null does.

### 3. Results ride the acknowledgement and never touch the Queue

**This is the boundary, and the rule beside it says the opposite.** ADR-0005 and
ADR-0006 are both built on "the panel is a pure function of the last published
Queue" — one message, one list, five members seeing the same thing. A list of
Results is none of those:

- It belongs to the **one member who typed**, who has not decided anything yet.
  Publishing it would put four other people's panels in front of a choice that
  is not theirs, and a second member typing would replace the first's list.
- It is **not state**. The Queue is what the bot is going to play; Results are
  a question the bot asked back, answered by choosing or by walking away.
- Nothing about it needs to survive a reload. If it is gone, the member types
  the name again.

So it travels back on the acknowledgement to the socket that asked — the same
path a refusal takes, and for the same reason: that answer is owed to one
person. It never goes through `music:publish`, it never appears in
`MusicQueueState`, and in the browser it is `useState` inside `MusicPanel` that
nothing else reads. The next person to work here will find the "read everything
from the room" rule first, and this is the exception to it.

**Choosing one is an ordinary `add`.** A Result carries the canonical link the
*bot* built from the video id, the browser hands that string straight back on
the same verb a paste uses, and the bot re-reads it exactly as it reads a pasted
one. The browser never constructs a YouTube URL, and nothing is trusted for
having been round the loop. It costs a second extractor call, which is correct
rather than wasteful: a flat search listing is not evidence that a Track is
playable, and the Queue should hold what a real resolve returned.

### 4. A search gets its own chain, and does not Summon

Every other request goes through the bot's one promise chain, because they
change the Set and two overlapping Summons would race to own the same
membership. A search changes nothing, so it does not belong in *that* chain.
Two things go wrong if it does:

- A member who typed a name waits behind somebody else's join — and, worse, a
  **Skip waits behind ten seconds of somebody else's search**. The chain exists
  to stop requests interleaving, not to make unrelated ones take turns.
- The chain's failure recovery ends the Set. That is the right answer to a
  Summon that broke halfway through and a catastrophic one to a search that
  did: the room would lose its music because somebody mistyped a name.

But taking it out of that chain must not take its *bound* with it. A search
still spawns an extractor, and running two of those at once against a source
that rate-limits by address is the one thing this feature has always refused —
it is the stated reason nothing is prefetched. So searches are serialised among
themselves, in a second chain. One each keeps both properties instead of trading
one for the other.

A search also **never Summons**. Asking what a name might mean is not asking for
the bot to appear anywhere, and if the bot is playing in another channel, a
Summon would take it out of that room — costing a Set to answer a question.

The budget follows from the second chain. `searchTimeoutMs` is 10s against the
server's `botAckTimeoutMs` of 25s, and the margin has to hold **two** of them,
because a search arriving while another runs waits out both. Unlike
`resolveTimeoutMs` it has no join to leave room for, because nothing follows it.
It is shorter than a resolve because a flat listing does no per-video
extraction: a search still running when a resolve would have finished is not one
that is nearly done. A third simultaneous search can still exceed the server's
timeout and be reported as `bot_timeout` — that needs YouTube to be hanging *and*
three members typing inside the same ten seconds, and "the bot did not answer in
time" is, in that case, exactly true. Choosing a Result then spends its own
separate budget, as any paste does.

### 5. Bounded on the way in, at the edge

`musicSearchResultsMax` is 5, and the source is asked for **ten**. A live stream
or a premiere among the hits is not a Result and gets dropped, so asking for
exactly five would hand a member three — or, for a name whose every hit is a
broadcast, "nothing matched that" for something that plainly did. The extra
costs nothing: it is the same one request either way.

Every string in a Result is bounded where the
extractor's output is read — the title and the channel by `musicTitleMaxLength`,
the same constant one Track's title uses, and the link rebuilt from a validated
eleven-character id rather than echoed from the listing. This is the same place
and the same rule as `parseTrackMetadata`, because it is the same problem
several times over: somebody else's strings, arriving unbidden, on their way to
a browser.

Five rather than ten because the panel owns no scroll region (`apps/web/AGENTS.md`),
so the list grows the page and sits above the Queue. Five is enough to show that
the top hit is a cover or an hour-long mix, which is the whole reason a list is
offered rather than the closest Result being queued outright.

## Consequences

- A third resolver — the Spotify link ADR-0004 anticipates — is another branch
  in `resolverFor` and another parse in `track.ts`. It needs no wire change, no
  new verb and no new event, because `add` already means "from this".
- Which Result is on offer is marked in the row itself — a border and its own
  line of text — and not left to the browser's focus ring. Focus does move to
  it, but a member who submitted with the pointer gets that focus moved
  programmatically, which browsers deliberately draw no ring for; the "already
  selected" the design asks for would otherwise be invisible to exactly the
  people who did not use the keyboard.
- The panel now holds one piece of state that is not derived from the room.
  Anything added beside it should be assumed to belong in the Queue instead
  until someone can say why it belongs to one member.
- `apps/bot/src/stream.ts` holds three argument lists rather than two. It is
  still not unit tested and the reason is unchanged: the way an argument list
  goes wrong is that a flag means something other than what was intended, which
  only the real binary can say.
- The bot has two paths through `handle` where it had one. The split is by
  whether a request can change the Set, which is the same question the chain
  exists to answer, rather than a new distinction.
- `add` no longer means only "add": it means "add what I meant", and sometimes
  the answer is a question. Anything that reads a successful ack has to branch.

## What is not settled here

**No real query has ever been put to yt-dlp from this repository.** The search's
argument list and the shape of what it hands back are written to yt-dlp's
documented behaviour, and `test/fixtures/search.json` is invented in exactly the
way the fixtures beside it are — its README says so and now says so about this
one too. Whether `--flat-playlist` names the channel on every entry, whether a
live result is always marked as one, and whether the flat listing's `duration`
is reliable are all documentation rather than evidence until somebody runs it.

This is the fourth thing in this feature waiting on a machine with the binaries:
the yt-dlp/ffmpeg fetch path has never run, traffic has never been forced
through TURN, and no browser Listener has confirmed anything by ear.

Ranking is the source's and stays the source's. "The closest" is whatever
yt-dlp listed first, and nothing here re-sorts, filters by popularity, or
prefers an official channel — each of which would be a judgement about somebody
else's catalogue that this product has no basis for making.
