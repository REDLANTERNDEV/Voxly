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

**Set log**:
The record of what members did during a Set — who queued a Track, who skipped one. It exists only for the duration of the Set.
_Avoid_: History, audit log, activity feed

### Terms still being resolved

- **Room vs channel** — the codebase types say `RoomSummary`/`RoomKind` while the interface and CSS say channel throughout. Pre-existing, unresolved, and out of scope for the music bot work.
