# ADR-0039 — A Server's Audit log is narrowed when read, not when written

- **Status:** accepted
- **Date:** 2026-11-13
- **Context:** extends [ADR-0038](0038-roles-add-up-and-rank-only-decides-who-manages-whom.md)'s
  closed list of Permissions; respects [ADR-0034](0034-the-invite-trail-is-owner-only-and-never-cut.md)
  and [ADR-0037](0037-private-channels-are-checked-on-read.md)

## Context

The server has written an `audit_events` line for most consequential actions
for a long time, but nothing read them back, and most lines held only an actor
and an action: "someone created a channel", without which. Owners asked for
what Discord calls the Audit log — who created, renamed or deleted a channel,
changed a Role, kicked or moved someone, deleted another member's message —
inside Server settings, filterable by member and by action.

Three existing decisions constrain who may see what:

- a Hidden private channel's name is not something every member may learn
  (ADR-0037);
- who created an Invite is part of the Invite trail, which is the owner's
  alone (ADR-0034);
- the table is also the operator's record, and holds an Account's own business
  — sign-ins, Devices, recovery, access links — that belongs to no Server's
  members.

## Decision

**A new Permission, View audit log,** joins the closed list. Like every other
Permission it adds up across Roles, and Administrator and the Server owner hold
it. This is how Discord gates the same view, and it lets an owner hand the log
to moderators without handing them Manage server.

**Every Server-scoped line records what it touched,** in an additive `details`
JSON column: a channel's id, name, kind and whether it was private; a Role's,
category's or Invite label's name; a rename's previous name; a move's
destination; which parts of a Role an edit changed. Names are recorded as they
were, so a line still reads after the thing is renamed or deleted. Message text,
tokens and anything else a member typed beyond a name are never written.

**Two actions start being logged:** a moderator deleting someone else's message
(deleting one's own is not moderation, as in Discord), and pinning or unpinning
a message. A pin that changes nothing writes nothing.

**Reading narrows; writing does not.** The route shows only the actions in
`auditLogActions` and keeps everything else in the table for the operator. For
each reader it withholds:

- the name of a channel the reader cannot see now, and of a deleted private
  channel unless the reader is an owner or holds Administrator — the line still
  shows, naming "a private channel";
- who created an Invite, unless the reader is the Server's owner.

Lines are ordered by time and then by write order (`rowid`), so lines written
in the same millisecond keep their order and paging never skips or repeats one.

## Consequences

- Lines written before this change have no details and read as a bare action.
- Nothing is pruned. Discord keeps 45 days; Voxly keeps what `audit.ts`
  already promised to keep, and a retention rule would need its own decision.
- A new Server-scoped action is invisible in the log until it is added to
  `auditLogActions` with a sentence in both languages; the web test that reads
  every action in English and Turkish fails until it is.
- Widening the Invite creator or a Hidden channel's name to more readers needs
  a decision that supersedes ADR-0034 or ADR-0037, not a change here.
