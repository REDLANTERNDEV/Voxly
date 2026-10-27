# ADR-0035 — A Status is held by the server, and Invisible is absence

- **Status:** accepted
- **Date:** 2026-10-27
- **Context:** extends [ADR-0019](0019-desktop-keeps-native-authority-local.md) and
  [ADR-0022](0022-desktop-call-reports-grant-no-actions.md); bounded by
  [ADR-0001](0001-music-bot-is-a-mesh-peer.md)

## Context

Presence used to be measured and nothing else: a member was online while a
connection was open and idle once every connection had gone without input for
the Server's AFK timeout. Members asked to say it themselves — Idle, Do Not
Disturb, Invisible — for a while or for good, the way other chat products let
them.

Four choices here are expensive to reverse:

- **Where a Status lives.** A Status held by one browser disagrees with the
  member's other Devices, and a timed one cannot end while every Device is
  asleep.
- **What Invisible puts on the wire.** A wire value of `invisible` tells every
  member's client who is hiding; the hiding then rests on every client agreeing
  not to show it.
- **What Do Not Disturb silences.** It could be a server rule that withholds
  events, or a local rule about sounds.
- **What the desktop may tell an installation.** A machine-wide idle signal is
  native knowledge, and the installation's JavaScript belongs to its operator.

## Decision

**The server holds the Status.** It is stored on the Account with its expiry,
sent back only to that member's own sockets, and outranks what their
connections measured: picked Idle or Do Not Disturb wins over a measured idle,
and the measurement applies only while Online is picked. The server times the
expiry itself and announces the change when it comes. A Status that has run out
reads as Online whether or not that has been written down yet.

**Invisible is absence.** An invisible member is left out of every other
member's online list and announced as offline, exactly like someone who
disconnected; no other member's client ever receives the word. `@here` passes
them by for the same reason. Only their own client sees them as Invisible.

**Invisible stops at the voice room.** Voice is a mesh: everyone in a room holds
a peer connection to everyone else, and anyone watching the room needs its
roster to show a meaningful room. An invisible member who joins a voice room is
therefore visible in that room, and only there. Hiding a peer from the peers
they are streaming to is not something this architecture can offer, and the
interface does not pretend to.

**Do Not Disturb is local.** Messages and mentions still arrive, unread counts
still move and `@here` still counts the member. Their own client drops the
message sound and the desktop alert before either is decided. A call they are
in keeps its own cues, because they are in it. Other members see the red dot,
which is the whole of what Do Not Disturb says to anyone else.

**The desktop sends two words, never a measurement.** On Windows the shell polls
the session's last-input time and whether the input desktop is the locked one.
It hands the installation's top frame, on the origin the member chose, one of
two fixed signals: `active` when input happened anywhere since the last poll,
and `away` when the session locks. No idle duration, timestamp, application or
window crosses, and nothing flows back to native: the bridge is a subscription,
not a command. A locked machine makes the member Idle at once; the next input
anywhere makes them present again. Sleep needs no signal, because a sleeping
machine drops its socket and the server already reports that as offline.

## Consequences

- A member can trust a timed Status to end on time even with every Device
  closed, and to read the same on all of them.
- Invisible cannot leak through a client that misbehaves, because no other
  client is told. It can leak through a voice room, by design.
- Do Not Disturb protects the member's attention, not their privacy; it is not
  a way to stop receiving messages.
- An installation's operator learns that a desktop member's machine is in use
  or locked, at 15-second resolution. That is no more than a page with focus
  and input listeners could infer while the member was looking at it, and less
  than a timestamp would give.
- Only Windows sends the desktop signal today. Other platforms fall back to the
  browser's own window, which is the behaviour every browser member already has.
- Showing a member's Status to anyone other than members of a Server they share,
  or adding a free-text status, needs a new decision.
