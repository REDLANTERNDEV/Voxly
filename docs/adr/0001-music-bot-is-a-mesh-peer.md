# ADR-0001 — The Music bot is a peer in the voice mesh

- **Status:** accepted
- **Date:** 2026-08-23
- **Context:** ticket 06, "The bot joins a voice channel and plays sound"

## Context

Voxly's voice is a full mesh. Every member holds one peer connection to every
other member in the room, media never touches the server, and the server's whole
part in a call is forwarding offers, answers and candidates between two people
it has already established are in the same room. `AGENTS.md` states that plainly
and defends it: *"Preserve the current peer-to-peer media architecture. Do not
introduce an SFU, media recording, or server-side media processing as an
incidental change."*

A Music bot has to put sound into a room. Read quickly, the rule above forbids
the feature outright — playing audio into a call is, on the face of it, exactly
the server-side media processing the rule rules out. That reading is what this
record exists to settle, because the alternative is that every future change to
this feature re-argues it from scratch.

The premise underneath the rule is worth naming, because it is what decides the
answer. The rule protects a property, not a topology: **the operator's server
never holds anyone's conversation.** A self-hosted deployment where the host
could record the room is a different product from one where it could not, and no
amount of good intent substitutes for the media not being there.

## Decision

The Music bot is **an ordinary peer in the mesh**. It is a separate process that
authenticates as an ordinary member ([ADR-0003](./0003-music-bot-service-account-credentials.md)),
joins a voice room through `voice:join`, negotiates over `rtc:signal`, and holds
**one peer connection per Listener** — the same shape, over the same wire, as a
person with a microphone.

Three things follow, and they are the substance of the decision rather than
details of it.

1. **The server's part does not change.** It forwards signalling between two
   members of a room, exactly as before. It gains no media path, no mixer, no
   decoder and no recording surface. The property the architecture rule protects
   is untouched: the operator's server still never holds a conversation.
2. **Every rule that applies to a member applies to the bot.** It is subject to
   the same authorization, the same voice moderation, the same room membership.
   Nothing in the product asks whether a caller is a bot before deciding what it
   may do.
3. **The bot enforces its own media state.** This is the price. Because media is
   peer-to-peer, the server *cannot* silence anything — it never sees the
   packets. Server-side moderation is therefore advisory for media, and the bot
   is required to honour its own `moderation.muted` and the AFK room's forced
   mute by not sending. The same asymmetry means nothing measures received
   audio, so the bot must report its own `speaking` state or its row in the
   member list stays dark while it plays. Both were observed rather than
   reasoned about, in the ticket 03 spike.

The bot runs in its own process and reaches Voxly only through the public HTTP
and Socket.IO surface, so "it is another client" is enforced by the dependency
direction rather than merely intended.

## Alternatives considered

**An SFU, or server-side mixing.** The obvious way to make one audio stream
reach many people. Rejected because it is the architecture change the rule
forbids, and not incidentally: an SFU terminates media at the server for *every*
call, not only for music. It would make the operator's host a place where
conversations exist in the clear, which is the one thing the design has been
protecting since the first commit. It also lands a new scaling and operational
burden — bandwidth, ports, CPU — on a product whose premise is that one person
can run it.

**Injecting audio into the members' existing peer connections from the server.**
Not possible without becoming the above. The server holds no keys, no
transports, and no media path; there is nothing to inject into.

**Every browser plays the Track locally, kept in step.** Tempting because it
costs no bandwidth at all. Rejected on three counts. Keeping independent
playbacks in sync across machines is a hard problem with no good answer over the
public internet, and "in sync" is the entire point of listening together. Every
Listener would fetch the source separately, multiplying extractor traffic and
the rate limiting that comes with it. And the bot would not be a member: it
could not be muted, disconnected or moved, so "moderate the Music bot the way I
moderate anyone" would have no meaning.

**A headless browser as the bot.** It would be a mesh peer, and it would work.
Rejected as disproportionate: a whole Chromium per deployment, with its own
memory footprint, sandbox requirements and upgrade treadmill, inside a product
that currently ships as one small Node container.

## Consequences

- The bot's upstream bandwidth grows with the number of Listeners, exactly like
  a person who is talking. The mesh's existing practical limit on room size is
  the bot's limit too; it does not introduce a new one, and it does not lift the
  old one.
- Encoding happens once and the same encoded packets go to every Listener, so an
  extra Listener costs one SRTP encryption rather than another encoder. That
  property is what [ADR-0002](./0002-werift-for-the-bot-webrtc-stack.md) selects
  the library for.
- The bot needs TURN on the same terms as anyone else, and obtains its
  credentials from the same authenticated `/api/rtc/config` endpoint.
- Moderation of the bot's *media* depends on the bot behaving. An operator who
  runs a modified bot can make it ignore a mute — which is true of a modified
  browser client too, and is a property of peer-to-peer media rather than of
  this decision.
- `AGENTS.md`'s architecture rule now names this record, so the rule keeps
  forbidding what it was written to forbid without also appearing to forbid a
  peer that happens not to be a person.
