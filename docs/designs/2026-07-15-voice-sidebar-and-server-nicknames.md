# Voice Sidebar and Server Nickname Design

## Goal

Make joining voice rooms easier, improve voice-control icon clarity, preserve
the existing custom member volume menus, and let the owner manage nicknames
without changing a user's identity in other servers.

## User Experience

### Voice sidebar status and channel icons

- A muted voice member shows one red muted-microphone icon.
- A deafened voice member shows the red muted-microphone icon on the left and
  the red deafened-headset icon on the right.
- Voice channel rows replace the `VC` prefix with an inline microphone icon.
  The channel name remains the accessible link label.
- The dock screen-share icon continues to use `currentColor`, but uses the same
  effective visual stroke weight as the other dock icons. It therefore matches
  the other controls in both light and dark themes instead of hard-coding
  white.

### Voice room activation

- Clicking a voice channel while disconnected starts the acknowledged voice
  join immediately. Navigation to the voice room happens only after the join
  succeeds.
- Clicking the active voice channel keeps the user in that room and opens its
  call surface without another join.
- Clicking a different voice channel while connected opens a confirmation
  dialog naming both the current and target rooms.
- Confirming performs the existing acknowledged atomic room move and navigates
  only after success. Cancelling leaves the current room unchanged.
- A failed or timed-out join leaves the user and route unchanged and uses the
  existing localized voice error surface.
- Direct voice-room URLs retain the existing explicit join control as a safe
  fallback because browsers should not request microphone access without a
  user gesture.

### Member context menus

- The existing shared portal context menu remains the only sidebar menu
  coordinator.
- A remote active voice participant has a listener-owned `0%` to `200%` volume
  control in the left voice rail and right member directory.
- Ordinary members receive no moderation controls.
- An owner receives nickname and existing moderation actions where permitted.
  The owner's own row offers nickname editing but no personal volume or
  moderation action.
- Opening a dialog closes the context menu first. Escape, outside input, focus
  restoration, touch access, and viewport clamping retain their current
  behavior.

### Nickname editing

- The owner may change the server nickname of a normal member or the owner's
  own server nickname.
- Nicknames are trimmed and must contain 2 to 32 characters. They do not need
  to be unique, matching the current nickname policy.
- The action is available from applicable sidebar member menus and the owner
  member table.
- The edit dialog starts with the effective current nickname, prevents repeated
  submission while pending, and remains open with a localized error if the
  request fails.
- English and Turkish copy and accessible labels are added together.

## Persistence and Authorization

Add a nullable `nickname` column to `server_members`. A null value means the
membership uses `users.nickname`; a non-null value is the server-specific
override. Existing SQLite databases receive the column through the additive
`addColumnIfMissing` migration path.

Add an owner-authorized server-member nickname endpoint. It must:

1. authenticate the global owner session;
2. require an active owner membership in the selected server;
3. require the target membership to exist and not be removed;
4. allow the owner to rename the owner account itself or a normal member;
5. reject attempts to rename a different owner;
6. validate and persist the trimmed nickname;
7. record a server-scoped audit event; and
8. return the effective server-scoped `PresenceUser`.

Banned but non-removed normal members remain visible in the owner panel and may
be renamed there. Removed members are not valid targets.

## Effective Nickname Boundary

The global `users.nickname` remains the account/default name. Server-scoped
surfaces resolve the effective nickname as:

```text
coalesce(server_members.nickname, users.nickname)
```

This resolution applies to:

- server directory and owner member responses;
- per-server online presence;
- voice join acknowledgements and snapshots;
- new-message payloads;
- message history and edited-message payloads; and
- the current user's display name inside the selected server.

Realtime handlers must derive a server-specific `PresenceUser` for the target
server instead of reusing the socket's global cached nickname. A nickname in
one server must never be emitted to another server.

## Realtime Updates

Add a typed `server:memberUpdated` event containing `serverId` and the updated
server-scoped `PresenceUser`.

After persistence succeeds, the server:

1. updates matching in-memory voice membership entries for rooms in that
   server;
2. emits updated voice snapshots for affected active rooms; and
3. emits `server:memberUpdated` only to `server:<serverId>`.

The web client uses `userId` to update the selected server's directory and
online-presence caches, loaded message authors, and the selected-server display
name. Voice state is refreshed by the authoritative snapshot. The owner panel
also updates from the successful response or its existing reload path.

## Component Boundaries

- Keep join-versus-confirm selection in a small deterministic helper so channel
  rows only orchestrate navigation, confirmation, and the existing join call.
- Keep effective-nickname SQL and conversion in server helpers used by HTTP and
  realtime producers.
- Extend the existing sidebar menu controls and confirmation/dialog patterns;
  do not introduce another menu coordinator or UI dependency.
- Keep shared DTO and Socket.IO event changes in `@voxly/shared` and update both
  producers and consumers together.

## Error Handling

- Nickname validation and authorization failures use stable server error codes.
  The client maps expected failures to localized copy and retains the dialog
  for correction or retry.
- Nickname UI updates occur after server success; there is no optimistic state
  that needs rollback.
- Voice movement disables repeated confirmation while joining. Failure keeps
  the current voice membership and route and surfaces the existing voice error.
- Late join acknowledgements retain the existing timeout and settle-once
  behavior.

## Verification

### Server and shared contracts

- Migration test for an older database without `server_members.nickname`.
- Authorization tests for normal-member denial, wrong-server denial, owner
  self-rename, normal-member rename, different-owner denial, removed-member
  denial, and nickname validation.
- Isolation tests proving the override affects only one server.
- Message tests proving history, create, and edit payloads use the effective
  nickname.
- Realtime tests proving `server:memberUpdated` is server-scoped and active
  voice snapshots change immediately.

### Web

- Pure helper tests for disconnected join, active-room no-op/open, and
  connected-room confirmation.
- Interaction/source tests for join-before-navigation, cancellation, failed
  joins, and confirmed room moves.
- Tests for muted/deafened left-to-right icon order, the microphone channel
  icon, and screen-share stroke parity.
- Context-menu tests for personal volume availability, owner nickname actions,
  self-row restrictions, menu exclusivity, and dialog handoff.
- English and Turkish translation tests for all new copy.

### Final commands

Run the affected workspace tests while iterating, then run:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

Inspect desktop, short-viewport, narrow, and coarse-pointer behavior in a
browser when available.

