# ADR-0037 — Private channels are checked on read

- **Status:** accepted
- **Date:** 2026-11-04

## Context

Until now, every active Membership could see every channel in its Server. Owners asked for channels that only chosen members can enter. Every Server-scoped surface reads channels: history, sending, reactions, unread state, Mentions, voice join, the voice snapshot, RTC signalling, the channel list, Summon and owner moves. So the rule has to be a single check that all of them call, not a filter applied in each place.

## Decision

A channel is either public or a **Private channel** with its own **Channel access**: a per-Membership allowlist. Every Server owner always has access and cannot be removed. The Installation owner gets nothing extra. A Private channel is either:

- **Hidden**: people without access do not know it exists.
- **Listed**: view-only for people without access. In text, they read history but cannot send, react, edit or wave. In voice, they see who is inside but cannot join and do not see the Call length.

Access is evaluated **when something is read**, not stored per message. Making a channel private, or removing someone from its list, therefore covers its whole history, including that person's own past messages. Losing access takes effect immediately: a voice member is disconnected, a viewer of a Hidden channel is moved off, and a viewer of a Listed channel becomes read-only.

The Music bot is never put on a list. A Summon by someone with access lets the bot into that channel for the Set. That way the authorization check never branches on whether the member is a Bot.

The AFK room and the Welcome notice channel cannot be private. Owners cannot move a member into a voice channel that member cannot enter.

## Considered options

- **Per-message visibility**, so people keep what they saw before the channel became private. Rejected: "private" would then mean something different for every member.
- **Roles now.** Rejected: roles belong to the levels and leagues work. An allowlist is the first kind of entry, and a role can become a second kind without a migration.
- **Separate read and write lists, or listen-only voice.** Rejected: one grant means full ordinary rights. A read-only announcements channel would be its own feature.

## Consequences

Three broadcasts that used to reach the whole Server now go to a chosen audience instead: `message:new`, `voice:joined`/`voice:left`, and the voice snapshot sent outside a room. Database changes are additive: two columns on `rooms` and a `room_access` table. Kicking, banning or deleting an Account clears that Membership's grants.
