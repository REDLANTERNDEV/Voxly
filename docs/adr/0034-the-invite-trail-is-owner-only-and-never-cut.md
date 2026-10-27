# ADR-0034 — The Invite trail is owner-only and is never cut

- **Status:** accepted
- **Date:** 2026-10-27
- **Context:** builds on [ADR-0017](0017-account-deletion-is-owner-gated-and-history-preserving.md)

## Context

Every Invite records its creator, and `invite_uses` records who joined through
it and when — including single-use invites from before that table existed,
which the schema upgrade copies across. Owners asked to see this: who created
an Invite, who it brought in, and how the people in a Server are connected
through Invites. Until now the owner panel showed none of it.

Two pressures pull against each other. The trail is moderation evidence — who
brought in the person who was banned — so it must survive the Invite going
stale. But past invites clutter the list owners use every day, and other chat
products simply delete them.

Who may see the trail is the harder choice to reverse. Once members can see
who joined through their own links, taking that away reads as hiding
something, and an owner's moderation record becomes a member-to-member view.

## Decision

The Invite trail is visible only to owners. A Server's owners see it for that
Server, from its Invites section. The Installation owner also sees it across
every Server, from an Account's details in `Accounts`. A member holding the
invite grant sees nothing new, not even who used their own Invites; the server
enforces this rather than the client hiding it.

An Account that was deleted stays in the trail as `Deleted member`, with its
dates; its former nickname is never kept or inferred (ADR-0017). Kicked, banned
and departed members stay in the trail, each marked with its own state. A
Membership with no Inviter says so plainly.

Past invites — expired, used up or revoked — leave the main list for a
collapsed group, and their trail stays one click away. Deletion depends on use,
never on age alone:

- an Invite that nobody ever joined through is deleted 30 days after it stopped
  being active, because it records nothing;
- an Invite that anybody joined through is kept for as long as its Server
  exists, because it _is_ the trail.

Deleting a Server still deletes its Invites and their uses, as before.

## Consequences

- The main Invites list matches what owners expect from other products without
  ever cutting the trail.
- The 30 days leave room to notice a link revoked by mistake.
- An audit line about a deleted unused Invite keeps an id that no longer
  resolves. The audit log is the operator's record, not the trail, so this is
  accepted rather than prevented.
- Widening the trail to any non-owner needs a new decision that supersedes this
  one.
