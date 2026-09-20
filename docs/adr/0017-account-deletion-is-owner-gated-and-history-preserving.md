# ADR-0017 — Account deletion is owner-gated and history-preserving

- **Status:** accepted
- **Date:** 2026-09-20

## Context

Voxly Accounts have no email address or password, may hold Memberships in
several Servers, and are referenced by sessions, Device access, invitations,
messages, and audit history. Deleting a `users` row would make authored history
disappear through existing joins and would leave several explicit lifecycles
pointing at nothing. Treating deletion as a Server moderation action would also
give one Server owner control over an installation-wide identity.

At the same time, the Installation owner needs two distinct capabilities: to
decide a member's Account deletion request and to remove an ordinary Account
without waiting for such a request. Neither capability replaces global ban,
which stops access immediately without anonymising the identity attached to
past conduct.

## Decision

Account deletion is one irreversible, installation-wide transition with two
entry paths:

1. a member submits an Account deletion request that the Installation owner may
   approve or reject; or
2. the Installation owner initiates deletion directly, without member consent.

Only the Installation owner may decide either path. An Installation owner, Bot,
Deleted account, or Account that owns any Server cannot enter the transition.
A Server owner may moderate a Membership but cannot delete the Account behind
it.

Deletion preserves the Account row as a neutral tombstone and preserves
messages, replies, Membership rows, and audit records. It removes personal
nicknames, ends active Memberships, revokes every credential and outstanding
access path, and makes the old Account unrecoverable. Presentation derives the
localized `Deleted member` label from deleted state; no translated tombstone
name is stored as identity data.

The transition is atomic and shared by both entry paths. Its audit outcome
records whether a member's request was approved or whether the Installation
owner initiated it. A global ban remains a separate moderation action and does
not imply deletion.

## Alternatives considered

**Immediate self-service deletion.** Rejected because the agreed product policy
requires Installation owner review before a member can anonymise their Account.

**Hard deletion and cascading cleanup.** Rejected because messages and audit
history must survive, and because the current explicit SQLite lifecycles are
not a safe cascade boundary.

**Deletion from a Server member menu.** Rejected because a Server-scoped action
must not silently destroy an Account and its Memberships in unrelated Servers.

## Consequences

- The Owner panel needs separate installation-wide surfaces for pending
  deletion requests and Accounts.
- Deleted state becomes part of shared identity and message presentation
  contracts; clients must not infer it from a nickname string.
- Every route and realtime operation that authenticates an Account must treat a
  Deleted account as unable to act, while historical reads keep its content.
- Account deletion requires additive schema evolution and focused tests across
  server, shared contracts, web presentation, and realtime eviction.
