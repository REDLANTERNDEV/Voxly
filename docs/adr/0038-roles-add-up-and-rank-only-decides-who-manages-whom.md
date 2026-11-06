# ADR-0038 — Roles add up, and rank only decides who manages whom

- **Status:** accepted
- **Date:** 2026-11-06
- **Context:** replaces the per-Membership invite grant; extends
  [ADR-0037](0037-private-channels-are-checked-on-read.md); leaves room for the
  levels and leagues work

## Context

Every Server-scoped authority in Voxly is held by the Server owner alone. About
25 routes and socket events check for it: channels and categories, the Server's
name, AFK room and welcome notice, members (list, nickname, voice moderation,
kick, ban, disconnect, move), invites and access links, and message moderation
(pin, clear reactions, delete another member's message). The only thing an
owner can hand to anyone else is one per-Membership switch, `can_invite`.

Owners asked for helpers: an Admin who can open Server settings and run the
Server, and a way to give or withhold invite rights by group rather than one
member at a time. The levels and leagues work will need the same structure,
with Roles that are given out automatically.

There are two well-known ways to combine roles:

- **Additive**, as Discord does it. A member's permissions are the union of
  `@everyone` and every Role they hold. Rank does not change what anyone may
  do; it decides only who may manage whom and which colour is shown.
- **Ordered override.** The highest Role's setting wins, including a "deny".
  This is what owners often guess Discord does. It is harder to predict, and
  a Role given for one reason can silently take away a right given for
  another.

## Decision

**A Server has Roles, and Permissions add up.** A member's Permissions in a
Server are the union of `@everyone` and every Role they hold. There is no deny
at Server level. **Administrator** grants every Permission and, like a Server
owner, every Private channel. The Server owner is not a Role. They stand above
every Role, hold every Permission, and cannot be the subject of any Role
action.

**Rank decides who manages whom, and nothing else.** A member's rank is the
position of their highest Role. A member with `Manage members`,
`Voice moderation` or `Manage roles` may act only on people whose rank is
below their own, and may give, change, reorder or delete only Roles below
their own highest Role. The owner is exempt. Two extra locks stop an Admin from
promoting themselves:

- Only the owner may give or remove the **Admin** Role, or change it.
- Only the owner may switch **Administrator** on or off on any Role.

**Fixed Roles.**

- **`@everyone`** is every Membership. It is always last, and it cannot be
  given, removed or deleted.
- **Admin** is always first under the owner, holds Administrator, and cannot
  be deleted.
- Every new Server also starts with **Davetçi / Recruiter**, holding
  `Create invites`. It is an ordinary Role.

On upgrade, each Server gains these three Roles, and every Membership with
`can_invite` set is placed in Davetçi. `@everyone` starts without
`Create invites`, so nobody gains or loses the right to invite.

**Permissions are a closed list:** Create invites, Manage channels, Manage
server, Manage roles, Manage members, Voice moderation, Manage messages,
Manage invites and Administrator. A few actions stay with the owner for good:

- deleting the Server, because it cannot be undone;
- access links, because one hands a person a way back into their Account;
- the Invite trail (ADR-0034).

**Channel access takes Roles as a second kind of entry,** as ADR-0037 allowed
for. A member may enter a Private channel when any of these is true:

- they are on its Channel access themselves;
- a Role they hold is on it;
- they hold Administrator;
- they are the Server owner.

It is still checked when something is read.

**Bots hold no Roles.** A Bot cannot be given a Role, and no Role action
targets one (ADR-0010).

**Every check stays on the server.** Each route and event that checked
ownership now asks one question: does this actor hold this Permission in this
Server, and, for an action on a member or a Role, do they outrank the target?
The browser only reflects the answer.

## Considered options

- **Ordered override with deny,** so that a higher Role overrides a lower
  one. Rejected for the reasons above. A Role-level deny can be added later,
  as a Channel overwrite, without changing how base Permissions combine.
- **Fixed Roles only** (Admin, an invite Role and `@everyone`, with no new
  ones). Rejected: the levels and leagues work needs Roles that the system
  hands out, and a closed set would have to be rebuilt.
- **Admin may grant Administrator.** Rejected: an Admin could then create an
  "Admin 2" Role and escape the rule that only the owner makes Admins.
- **Calling the invite Role "Inviter".** Rejected: Inviter already names the
  Account that created an Invite (`CONTEXT.md`, ADR-0034).

## Consequences

- Owner-only checks on the server become Permission checks. Every one of them
  needs a regression test that a plain member is still refused.
- The owner panel keeps only what covers the whole installation: Accounts and
  Deletion requests. Everything about one Server moves to Server settings,
  which anyone holding at least one Permission can open.
- Database changes are additive: new `roles`, `member_roles` and
  `room_access_roles` tables. The `can_invite` column stays but is no longer
  read.
- Changing a Role or a Permission has to reach every open screen at once, and
  so does losing access to a Private channel through a Role.
