# ADR-0005 — How the Queue reaches every member

- **Status:** accepted
- **Date:** 2026-08-25
- **Context:** ticket 08, "The Queue"

## Context

The design makes the bot the single source of truth for the Queue and playback
state: *"the bot applies or rejects each one and broadcasts the resulting state
to everyone in the room."* Nothing in the product could do that.

Until now the only thing the bot ever said that reached a person was the
acknowledgement of that person's own request. Someone pastes a link, the server
forwards it to the bot, the bot answers, and the server relays the answer back
along the same thread. It works, and it reaches exactly one member: the one who
pasted. Everyone else in the channel hears music start and is shown nothing at
all about where it came from or what follows.

The obvious fix is for the bot to emit to the room. It cannot. The bot is an
ordinary member with an ordinary socket ([ADR-0001](./0001-music-bot-is-a-mesh-peer.md)),
and no member in Voxly can emit to a room — the server does that, after it has
decided who may. `AGENTS.md` says it plainly: *"the browser must not infer
permissions that the server does not enforce"*, and the bot is a browser as far
as authorization is concerned. Adding a relay that forwards whatever the bot
sends, to whichever room it names, would make the bot the one client in the
product with a broadcast primitive.

Two further things had to be settled with it, and both are expensive to change
afterwards because the panel, the wire format and every future Queue feature
rest on them: what happens to a member who joins after the music started, and
how a Requester gets a name.

## Decision

### 1. The bot asks; the server authorizes and fans out

A new pair of events, and no more than a pair:

- `music:publish` — client to server, from the bot: *this room, this Queue*.
  Acknowledged.
- `music:queue` — server to client, to the voice room: *this room, this Queue*.

`music:publish` is checked before anything is sent anywhere. The publisher must
**be that server's own Music bot account**, and it must **still be in that voice
room**. Both are the server's own knowledge — the account comes from the
database, the membership from `VoiceRealtime` — so neither is a claim the
publisher gets to make about itself. The payload is validated and bounded like
any other input, because it is relayed to every member of the room and the
strings in it originated at YouTube rather than at anyone Voxly authenticated.

The alternative was to widen the existing `music:command` acknowledgement into
something the server fans out. Rejected: it answers the asker, and the whole
problem is the four people who did not ask. The other alternative was a generic
"emit to my room" event for bots. Rejected harder — it is the broadcast
primitive, wearing a hat.

Delivery is to `voice:<roomId>` and not to the server room. Who queued what is
the business of the people listening, on the same footing as the room's speaking
state, which is already private to the voice room for the same reason.

### 2. The server stores nothing

There is no server-side copy of the Queue. A member who joins a channel
mid-Set is told by the bot: the bot watches the room's roster in the snapshots
it already receives and publishes again whenever it changes.

The alternative was for the server to remember the last published Queue per room
and hand it to whoever joins. It is one line shorter at the join and wrong in a
way that costs more than it saves: it is a second copy of state the design gave
to exactly one owner, it goes stale the moment the bot restarts or is evicted,
and "the server's idea of the Queue" becomes a thing that can differ from the
Queue. Republishing costs one small message per arrival, in a product whose
rooms hold a handful of people.

This also settles the ordering when a Set ends: the Queue is published empty
**before** the bot leaves the room, because a publish from a member the server
has already seen leave is one the server correctly refuses. The browser does not
depend on that arriving — it shows no Queue when no bot is in the room — but the
bot should not be in the habit of narrating a Set it has left.

### 3. The Requester crosses the wire as an id

A Queue entry carries `requestedByUserId`, and the browser resolves the name.

The bot knows ids. It is handed one with every request and never sees a member
list the way a person does. Every browser, meanwhile, is already holding the
room's members and already renders their current nicknames everywhere else in
the interface. A nickname copied onto the wire by the bot would be a second copy
of identity the server already publishes, and it would be the copy that goes
stale — a member who renames themselves would keep the old name on their Tracks
until each one played out.

A Requester who has since left the room is named by a stand-in sentence rather
than by their id. Their id would be true and useless; nobody in a channel can
read a UUID.

## Consequences

- The bot has one capability no other member has, and it is narrow enough to
  state in a sentence: it may hand its own room a Queue. Everything else it does
  goes through the events a browser uses, unchanged.
- An owner who disconnects the bot stops its Queue as well as its audio, without
  anything being written to enforce that: the membership check fails, the
  publish is refused, and the panel empties because the bot has left the
  snapshot.
- The Queue is bounded (`musicQueueMaxEntries`) because it is broadcast whole on
  every change. A full Queue is refused at the door with its own member-facing
  sentence rather than silently dropped.
- Adding a Queue feature — removing an entry, reordering, a Set log — costs a
  field on `MusicQueueState` and nothing else. There is one publisher, one
  authorization point and one delivery.
- Two members watching the same channel from different machines can be shown
  different Queues only for as long as one message is in flight. There is no
  merge and no delta, so there is no state either of them can be left holding
  that the bot never sent.

## What is not settled here

Whether a Track is prefetched before the one in front of it finishes is not an
architectural decision and is recorded in `apps/bot/AGENTS.md` with its
reasoning. Today it is not: the boundary between two Tracks is the prebuffer
[ADR-0004](./0004-fetched-audio-path.md) already accounts for, which by the code
means silence rather than lost music — though nobody has heard one, so its
length is unmeasured.

Transport controls and simultaneous skips are ticket 09; the Set log is ticket
11. Both publish through this path.
