# Voxly

A self-hosted voice and text chat server for small private groups. Voice, camera, and screen media travel peer-to-peer between members; the server carries signalling, identity, and room state.

## Language

### Music bot

**Bot**:
A non-human member of a server, visibly marked as such wherever members are shown.
_Avoid_: Integration, app, service account

**Music bot**:
The Bot that plays audio into a voice room. A server has at most one.
_Avoid_: DJ, player, music player

**Summon**:
The act of bringing the Music bot into a voice room. Only a member already in that voice room can summon, and the first playback request performs it.
_Avoid_: Invite, add, call

**Listener**:
A member present in the voice room the Music bot is playing into. The Music bot holds one peer connection per Listener.
_Avoid_: Audience, viewer, subscriber

**Track**:
One piece of audio the Music bot can play, identified by its source and playable start to finish.
_Avoid_: Song, video, item, media

**Queue**:
The ordered list of Tracks the Music bot will play, belonging to the voice room it was summoned into.
_Avoid_: Playlist, list, backlog

**Requester**:
The member who added a particular Track to the Queue. Every Queue entry has exactly one.
_Avoid_: Owner, adder, submitter

**Grace period**:
The five minutes the Music bot waits in an emptied voice room before leaving. It exists because a member reloading the page briefly leaves the room, and the Queue should survive that.
_Avoid_: Timeout, idle window, linger

**Set**:
The stretch from a Summon until the Music bot leaves the voice room. Deliberately not called a session, which Voxly already uses for authentication.
_Avoid_: Session, playback session

**Search**:
Turning a typed name into several Results to choose between. A resolver, like a pasted link — not a separate feature and not a separate control.
_Avoid_: Lookup, query, find

**Result**:
One Track a Search offered. It belongs to the member who typed the name, is never shown to the room, and stops existing when one is chosen.
_Avoid_: Match, hit, candidate, suggestion, option

**Set log**:
The record of what happened during a Set — who queued a Track, who skipped one, and the Tracks that would not play when their turn came. Every line but those names a member; a Track failing is the one thing in it the Music bot says about itself. It exists only for the duration of the Set.
_Avoid_: History, audit log, activity feed

**Reply**:
What the Music bot says back to the one member who just asked for something — whether the request was taken or refused. It belongs to that member, is never shown to the room, and gives way to their next request. Distinct from the Set log, which is the room's record; wider than an *answer*, which in the control protocol names only a request that succeeded.
_Avoid_: Answer, response, status, notification, toast

### Devices and access

**Device**:
One browser holding one session for a member. Shown to that member as something
they can see and sign out. A member has as many as they have signed in.
_Avoid_: Client, browser, login, terminal

**Link code**:
The short code a signed-in Device shows so another Device can join the same
account. Worth ninety seconds and one use.
_Avoid_: Pairing code, transfer code, one-time password, OTP

**Recovery code**:
The durable secret a member holds so they can reach their account with no
signed-in Device left. Redeeming it signs every other Device out.
_Avoid_: Backup code, master key, password, seed

**Link**:
The act of bringing a second Device onto an account with a Link code. Distinct
from *Recovery*, which is the path taken when no Device is left to link from.
_Avoid_: Pair, connect, transfer, add

**Invite**:
Unchanged, and deliberately not either of the above: an Invite admits a new
*person*, and only the owner may issue one. Linking a Device and recovering
access are a member's own business and never route through the owner.
_Avoid_: using "invite" for anything a member does to their own account

### Where a source's own words are allowed

**Track** is what *Voxly* calls a piece of audio, and nothing in Voxly should
call it a video, a song, an item or media. That rule is about our own concept.
It does not extend to naming somebody else's: a YouTube video is a video, and
telling a member "that is not a link to a YouTube video" is more use to them
than any word of ours would be. The test is whose object is being named — ours
takes our word, theirs takes theirs.

### Terms still being resolved

- **Room vs channel** — the codebase types say `RoomSummary`/`RoomKind` while the interface and CSS say channel throughout. Pre-existing, unresolved, and out of scope for the music bot work.
