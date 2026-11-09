# Voxly

A self-hosted voice and text chat server for small private groups. Voice, camera, and screen media travel peer-to-peer between members; the server carries signalling, identity, and room state.

## Language

### Accounts and membership

**Installation**:
One running Voxly at one address, with its own Accounts and Servers. An Account
never spans two: a person on two Installations is two Accounts, and an Invite
belongs to exactly one.
_Avoid_: Instance, deployment, host (in copy)

**Account**:
One person's installation-wide identity in Voxly. An Account may hold a
Membership in several Servers and may be signed in on several Devices.
_Avoid_: User; "profile" for the identity itself (see Profile)

**Membership**:
An Account's place in one Server, including its server-specific nickname, role,
and access state.
_Avoid_: Account, login

**Profile**:
How an Account reads to the people it shares a Server with: its account
nickname, and the nickname each Membership puts in its place. A Membership with
no nickname of its own shows the account nickname. The Profile dialog edits the
Membership nicknames; nothing in a Profile is a credential.
_Avoid_: Account (the identity), avatar settings

**Installation owner**:
The Account with installation-wide authority over Accounts and Devices. This is
neither the operator who runs the host nor a Server owner acting within one
Server.
_Avoid_: Operator, admin, Server owner

**Server owner**:
An Account whose Membership gives it authority over one Server. That authority
does not extend to the Account itself outside that Server.
_Avoid_: Installation owner, operator

**Deleted account**:
An irreversible Account tombstone whose credentials and personal names are
gone while authored history remains attributable to a neutral deleted member.
_Avoid_: Banned Account, removed Membership, deactivated Account

**Account deletion request**:
A member's pending request for the Installation owner to approve or reject
turning their Account into a Deleted account.
_Avoid_: Support ticket, Membership removal request

### Messages and external content

**Mention**:
A selected reference to a person, every active member (`@everyone`), or the
members online when the message was sent (`@here`). A person's Mention refers
to their identity even when their nickname changes.
_Avoid_: Tag, username

**Mention code**:
A stable short identifier for one Membership, shown beside its nickname to
distinguish people with the same or similar names.
_Avoid_: Username, discriminator, Account identifier

**Draft**:
What a member left unsent in one channel's composer — its text, Mentions and
the message it replies to. It waits there while they move between channels
and is forgotten when the app closes or reloads; it is never written to disk
and nothing reminds anyone of it. Emptying the composer discards it.
_Avoid_: Saved message, unsent message (that is an outbox entry)

**Message reaction**:
An emoji attached to a message by a member. Members sharing an emoji form one
reaction group; its count is the number of members in that group.
_Avoid_: Message emoji, rating

**Welcome notice**:
The line a Server posts in a member's name when they join through an Invite,
which other members answer by waving. On by default; anyone holding Manage server turns
it off or chooses its channel. It carries no text of its own: each reader sees it
in their own language.
_Avoid_: System message, join message, greeting

**Pinned message**:
A message a Manage messages holder selected for the channel's shared pinned list.
_Avoid_: Bookmark, personal favorite

**External preview**:
Third-party content displayed from a supported link in a message. Loading one
contacts its Provider; the ordinary link remains usable without it.
_Avoid_: Cookie, OpenGraph card, attachment

**Provider**:
The third-party site from which an External preview is loaded.
_Avoid_: Integration, plugin

### Music bot

**Bot**:
A non-human member of a server, visibly marked as such wherever members are shown.
_Avoid_: Integration, app, service account

**Music bot**:
The Bot that plays audio into a voice channel. A server has at most one.
_Avoid_: DJ, player, music player

**Summon**:
The act of bringing the Music bot into a voice channel. Only a member already in that voice channel can summon, and the first playback request performs it.
_Avoid_: Invite, add, call

**Listener**:
A member present in the voice channel the Music bot is playing into. The Music bot holds one peer connection per Listener.
_Avoid_: Audience, viewer, subscriber

**Track**:
One piece of audio the Music bot can play, identified by its source and playable start to finish.
_Avoid_: Song, video, item, media

**Queue**:
The ordered list of Tracks the Music bot will play, belonging to the voice channel it was summoned into.
_Avoid_: Playlist, list, backlog

**Requester**:
The member who added a particular Track to the Queue. Every Queue entry has exactly one.
_Avoid_: Owner, adder, submitter

**Grace period**:
The five minutes the Music bot waits in an emptied voice channel before leaving. It exists because a member reloading the page briefly leaves the channel, and the Queue should survive that.
_Avoid_: Timeout, idle window, linger

**Set**:
The stretch from a Summon until the Music bot leaves the voice channel. Deliberately not called a session, which Voxly already uses for authentication.
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
What the Music bot says back to the one member who just asked for something — whether the request was taken or refused. It belongs to that member, is never shown to the room, and gives way to their next request. Distinct from the Set log, which is the room's record; wider than an _answer_, which in the control protocol names only a request that succeeded.
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
from _Recovery_, which is the path taken when no Device is left to link from.
_Avoid_: Pair, connect, transfer, add

**Invite**:
Deliberately not either of the above: an Invite admits a new _person_ to one
Server, and only a member holding that Server's Create invites Permission may
issue one. Linking a Device and recovering access are a member's own business
and never route through an owner. Someone who already has an Account on this
Installation redeems an Invite as that Account, never as a new one (ADR-0036).
An Invite stops being _active_ when it
expires, is used up or is revoked; it then becomes a _past invite_.
_Avoid_: using "invite" for anything a member does to their own account

**Inviter**:
The Account that created the Invite a Membership was activated through. Every
Membership has at most one; one created another way — by founding the Server,
by an owner's access link, or as the Music bot — has none.
_Avoid_: Referrer, sponsor, parent

**Invite trail**:
Who created each Invite of a Server, and who joined through it and when. Only
owners see it: a Server's owners for that Server, the Installation owner
across all of them (ADR-0034).
_Avoid_: Referral tree, invite log, audit log (that is the operator's)

### Presence

**Presence**:
What other members see of whether someone is here right now: online, Idle, Do
Not Disturb, or offline. It is derived by the server from the member's Status
and their connections, and it is only ever shown inside a Server they share.
_Avoid_: Status (that is what the member picked), activity, availability

**Status**:
What a member picks for themselves from the account menu — Online, Idle, Do Not
Disturb or Invisible — for a set time or until they change it. It belongs to
the Account, so every Device agrees, and it outranks what their connections
measured (ADR-0035).
_Avoid_: Presence, mood, custom status, availability

**Idle**:
Present but not at the keyboard, either because the member picked it or because
no input reached any of their Devices for the Server's AFK timeout. Idle marks a
member; it never moves them.
_Avoid_: Away, AFK (that is the room), inactive

**Do Not Disturb**:
A Status that keeps message sounds and alerts quiet on the member's own Devices.
A call they are in keeps its own cues.
_Avoid_: Busy, DND in copy, quiet mode, mute (that is a Server's notifications)

**Invisible**:
A Status under which other members see the member as offline everywhere except
a voice channel they are actually in.
_Avoid_: Hidden, offline mode, ghost

### Voice

**Call**:
The stretch of time a voice channel is occupied: it begins when the first person
joins the empty channel and ends when the last person leaves. The Music bot neither
starts a Call nor keeps one going, and the AFK room never holds one.
_Avoid_: Session, meeting, conversation; arama in Turkish copy (that is search)

**Call length**:
How long the current Call in a voice channel has run, visible to everyone who
can enter that channel — for a public channel, everyone in the Server. It
belongs to the channel; a member's own time in voice is a different measure.
_Avoid_: Timer, duration, uptime

### Roles

**Role**:
A named group of Memberships in one Server, carrying Permissions, a rank, an
optional colour, and whether its members show separately in the member list.
A member's Permissions are the union of every Role they hold; a Role never takes
a Permission away (ADR-0038).
_Avoid_: Rank (that is the Role's position), group, title

**@everyone**:
The Role every Membership holds without being given it. It is always last, and
it cannot be given, removed or deleted.
_Avoid_: Default role, base role, members

**Admin**:
The fixed Role at the top of a Server's Roles, holding Administrator. Only the
Server owner gives it, removes it or changes it. It is a Role inside one
Server, never the Installation owner.
_Avoid_: Moderator, operator, owner

**Permission**:
One named right inside a Server — Create invites, Manage channels, Manage
server, Manage roles, Manage members, Voice moderation, Manage messages, Manage
invites, or Administrator. The list is closed; the server checks it on every
action.
_Avoid_: Grant (that was the old per-member invite switch), privilege, access

**Administrator**:
The Permission that holds every other Permission and enters every Private
channel. Only the Server owner switches it on or off.
_Avoid_: Admin (that is the Role), superuser

**Rank**:
The position of a member's highest Role. It decides only whom they may manage:
they act on people, and change Roles, strictly below it. It never changes what
a Permission allows. The Server owner stands above every rank.
_Avoid_: Level (that is the levels and leagues measure), priority

**Server settings**:
The window where a Server is run: its overview, Roles, members, invites and
bans. Anyone whose Permissions reach at least one of its sections opens it,
and sees only those sections. It is not the owner panel, which covers the
whole installation.
_Avoid_: Owner panel, dashboard, admin panel

### Channels

**Channel**:
One entry in a Server's channel list: a text channel or a voice channel. The
code says `room` (`RoomSummary`, the `rooms` table) for the same thing; that is
legacy spelling, not a second concept.
_Avoid_: Room in copy, glossary and new comments

**Private channel**:
A Channel only its Channel access, members holding Administrator and the
Server's owners may enter — read and write for text, join and talk for voice. Whether it is checked is decided when
something is read, so it covers the Channel's whole history (ADR-0037).
_Avoid_: Locked channel, secret channel, restricted channel

**Channel access**:
The members and Roles chosen for one Private channel. Being on it, directly or
through a Role, grants everything an ordinary member may do in that Channel;
Server owners and Administrator holders are always on it implicitly, and a Bot
is never on it (ADR-0037, ADR-0038).
_Avoid_: Whitelist, allowlist (in copy), permissions

**Hidden**:
A Private channel that people without Channel access do not know exists.
_Avoid_: Invisible (that is a Status), secret

**Listed**:
A Private channel that people without Channel access can see but not use: they
read a text channel's history and see who is in a voice channel, but cannot
write, react, join, or see the Call length.
_Avoid_: Public, read-only channel (that would be a different feature)

### Where a source's own words are allowed

**Track** is what _Voxly_ calls a piece of audio, and nothing in Voxly should
call it a video, a song, an item or media. That rule is about our own concept.
It does not extend to naming somebody else's: a YouTube video is a video, and
telling a member "that is not a link to a YouTube video" is more use to them
than any word of ours would be. The test is whose object is being named — ours
takes our word, theirs takes theirs.
