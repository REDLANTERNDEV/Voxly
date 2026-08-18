# Server Instructions

These instructions apply to `apps/server` in addition to the repository root
guidance.

## Responsibilities and Structure

The server workspace owns Fastify HTTP routes, cookie sessions, SQLite schema
and migrations, Socket.IO authorization and state, RTC configuration, static
web serving, and owner recovery CLIs.

- `src/app.ts` is the HTTP and realtime composition root.
- `src/db/schema.ts` defines Drizzle table metadata.
- `src/db/database.ts` initializes SQLite and performs compatibility migrations.
- `src/auth` owns token hashing and owner-claim behavior.
- `src/rtcConfig.ts` produces authenticated browser ICE configuration.
- `src/security.ts` builds the response header policy every route shares.
- `src/analytics.ts` resolves the optional analytics provider and the origins
  its policy needs.
- `test/app.test.ts` covers HTTP, persistence, membership, and migrations.
- `test/realtime.test.ts` covers Socket.IO authorization and voice state.

Keep SQL explicit and server-scoped. Prefer a small helper for repeated
authorization or normalization rules rather than duplicating subtly different
queries across endpoints.

## Database Compatibility

- SQLite files from earlier releases must remain usable. Add columns with the
  existing `addColumnIfMissing` migration pattern and choose safe defaults for
  legacy rows.
- Do not drop or reinterpret audit-relevant rows as an incidental cleanup.
- Keep schema metadata, runtime initialization, SQL queries, and migration tests
  synchronized.
- Migrate `invites.max_uses`, composite-keyed `invite_uses`, and membership
  `moderator_muted` / `moderator_deafened` / `can_invite` additively. Backfill legacy invite
  consumption once, retain the legacy first-use metadata, and preserve owner
  moderation values across restarts and membership lifecycle changes.
- Legacy user-to-default-server backfill runs only when introducing the
  `server_members` table to an older database. Routine startups and later
  migrations must never infer default-server membership from global `users`;
  doing so leaks members from one server into another.
- Operations described as atomic must complete their related validation and
  writes before publishing realtime state. Avoid partial external visibility.
- Never commit generated `.sqlite`, `-shm`, or `-wal` files.

## Authentication and Sensitive Tokens

- Invite, session, access-claim, and owner-claim tokens are stored only as
  hashes. Do not log or persist raw values.
- Invite expiry and capacity are independent nullable limits. Count one use per
  account in `invite_uses`; preserve the legacy first-use columns as metadata.
- When supplied, invite expiry accepts only 30, 60, 360, 720, 1440, 10080, or
  43200 minutes, and capacity accepts only 1, 5, 10, 25, 50, or 100 uses;
  `null` means unlimited. Do not accept the removed `expiresInHours` shape or
  arbitrary numeric values as a compatibility shortcut.
- An authenticated active member may reopen the exact invite that they
  previously consumed. Return `already_server_member` with that invite's
  `serverId` without restoring membership or consuming another use.
- Keep unknown, expired, exhausted, revoked, repeated-by-a-removed-member, and
  orphaned invite responses generic. Validate capacity and insert the use in
  the same `BEGIN IMMEDIATE` transaction as membership activation.
- Access links expire after 15 minutes. Creating a replacement revokes every
  older unconsumed, unexpired, non-revoked claim for the same server and user
  before inserting the new claim.
- Preserve revoked and consumed claim rows for auditability. At most one active
  unused access link may exist per server/member pair.
- Unknown, expired, consumed, revoked, or orphaned access claims all return
  `access_claim_invalid`; do not disclose the underlying state.
- A successful access claim returns the claimed `serverId` with the current
  user so the client can leave the claim route.
- Keep owner bootstrap disabled over HTTP unless explicitly enabled. Owner
  recovery through the CLI must not create duplicate owners unintentionally.
- TURN shared secrets remain server-only. Issue short-lived credentials only to
  authenticated users and reject partial or unsafe TURN configuration.

## Membership and Moderation

- Every server-scoped route and event requires an active, non-banned,
  non-removed membership; owner actions additionally require active owner role.
  Invite creation is the sole exception: an active member holding the
  `can_invite` grant may create invites for that server.
- `server_members.can_invite` is an owner-assigned, per-server grant. Only an
  active owner may set it, and only on ordinary members — owners already hold
  every permission, so their row stays untouched. Listing and revoking invites
  remain owner-only, so a delegated inviter can add people but cannot audit or
  undo anyone's links.
- Banning or kicking clears `can_invite`, so a member who later returns through
  a new invite cannot resume issuing links without a fresh grant.
- Accepting a valid invite as an existing active member returns the target
  `serverId` and leaves its remaining capacity unchanged. Reopening a previously
  consumed invite never restores a removed or banned membership.
- A user account is global but each membership is independent and
  server-scoped. When an existing user accepts a valid available invite to a
  different server, add or reactivate only that target membership, consume the
  invite, preserve every other active membership, and return the invited
  `serverId`. The authenticated server list must then expose both memberships.
- Kicking sets `removed_at`, revokes effective access, disconnects realtime
  membership, and excludes the user from owner member lists. A kicked user may
  return through the existing invite flow.
- Banning is distinct from kicking. Banned users remain visible to owners so
  they can be unbanned, and existing sessions must not restore access.
- Owner voice mute/deafen are independent, persistent membership flags. Only an
  active owner may update an ordinary member; owner/self targets are rejected.
  Neither kick, ban, rejoin, channel movement, nor restart clears these flags.
- The member directory is available to active members and exposes only active
  users' `userId`, `nickname`, `role`, and `canInvite`. Omit banned/removed
  memberships and all moderation/session fields.
- Membership changes emit the existing directory/access events to the correct
  server rooms. Do not broadcast server-scoped data globally.
- Preserve exact-name destructive confirmation at the client and enforce final
  owner-server/channel protections on the server.
- Server deletion remains atomic while preserving global identities and audit
  history that other servers still need. Delete dependent `invite_uses` before
  deleting that server's invites.
- Server names are owner-managed, trimmed to 2–64 characters, persisted before
  publication, and updated only after active owner authorization in that
  server. Record the rename in the audit log and emit the typed update only to
  the renamed server room.
- Invite links identify an invite, not a cached server name. Preview a valid,
  unexhausted, unrevoked, unexpired invite by joining its current server row so an
  older link shows the latest name after a rename. Keep every invalid preview
  response generic.
- Store an optional nickname override on `server_members`; the global user
  nickname remains the fallback. Only an active owner of that server may set a
  trimmed 2–32 character override for ordinary members or themselves, never a
  different owner.
- Every server-scoped directory, owner list, message, presence, and voice shape
  uses the effective membership nickname. After an update, refresh active voice
  snapshots and emit the typed member update only to that server room.

## Messages and Rooms

- Persist messages only in text rooms and enforce server membership before
  history, create, edit, or delete operations.
- Message bodies remain trimmed, non-empty, and capped at 2,000 characters.
- Members may edit/delete their own messages; owners may delete other users'
  messages but do not gain edit ownership.
- Keep creation time stable on edit and set `editedAt` separately.
- Persist suppressed rich-preview keys with each message as a bounded list with
  an additive legacy-safe default. Only the message author or an active owner
  of that message's server may suppress one key, and the operation must still
  require active membership in the text room's server.
- Preview suppression keeps the message body unchanged, persists before
  acknowledgement, and emits the updated message only to that room. The server
  never fetches link metadata, executes webhooks, accepts arbitrary embed HTML,
  or treats client-side preview visibility as authorization.
- Room and server deletion must remove or invalidate dependent live state and
  notify affected clients without leaking events to unrelated servers.
- A reply stores only the id it answers. The quoted excerpt is resolved at read
  time, joined on the same room and excluding deleted rows, so a quote can never
  disclose a message the reader could not otherwise fetch, and an edit or a
  rename is reflected without rewriting stored replies.
- Reject a reply whose target is not a live message in the same room. Deleting
  the target afterwards leaves the reply intact with a null quote; it does not
  delete or rewrite the answer.
- Excerpts are trimmed server-side. A full 2,000-character body must not be sent
  again behind every reply to it.
- A room flagged `is_afk` closes the microphone for everyone in it, owners
  included, and the mute cannot be lifted from inside — leaving the room is how
  it is released. Enforce it inside `normalizeVoiceMedia` rather than at any call
  site, so join, later media changes, and moderation recalculation all apply it;
  an unmute that reached only one of those paths reopened the microphone.
- Server enforcement stops the indicator, not the sound: media flows peer to
  peer, so the client must also hold the local track closed. Neither half is
  sufficient alone.
- The AFK timeout is per server, owner-only, and restricted to the shared option
  list; legacy rows with no value read as the default. Changing it emits to the
  whole server room, because every member runs their own idle clock.
- Presence status is per connection. A member is away only when every one of
  their sockets says so, and dropping an idle socket has to re-publish the
  derived status rather than leave it stale. Status never adds or removes a
  member from the online list — that is what online and offline mean.
- Every server carries exactly one AFK voice room, flagged by `rooms.is_afk`.
  Seeding runs for existing servers too, additively, so a deployment upgrading
  into the feature is not left with nowhere to park idle members. It skips
  servers that already have one, so it is safe to re-run and an owner who
  deletes theirs is not given it back on the next restart.
- The AFK room is otherwise an ordinary room: renameable, movable, deletable,
  and counted by the last-room floor. The server enforces nothing about who may
  be in it and needs no dedicated move endpoint — being parked is a normal
  `voice:join`, which already handles leaving the previous room atomically.
- Every change to a server's room list is announced on `server:roomsChanged` to
  that server's room, creation included. Members hold a cached room list, so a
  route that mutates rooms and stays silent leaves a new channel invisible until
  each client reloads. Only a deletion carries `deletedRoomId`, which moves
  viewers off a room that no longer exists.

## Atomic Voice and Realtime State

- `voice:join` accepts a typed `VoiceJoinRequest` and requires an ACK. Do not
  accept the legacy room-ID-only form.
- Validate that the target is an existing voice room and that the user has
  active access before changing membership.
- Normalize requested media before storing it: `deafened: true` forces
  `mic: false`; either mic-off or deafen forces `speaking: false`; every new
  membership starts with `speaking: false`.
- Owner mute additionally forces `mic: false` and `speaking: false`. Owner
  deafen does not alter the member's microphone state. Apply this normalization
  on both join and every media-state update.
- Build the ACK and emitted snapshot from the same authoritative
  `VoiceMemberState`. Never publish a temporary default `mic: true` state.
- A user account remains in at most one voice room globally. Moving rooms must
  clean the previous membership and visual subscriptions.
- Keep visual publisher limits and subscription authorization server-side.
  Signals are forwarded only between active members of the same voice room.
- Full speaking state is visible only to sockets joined to that voice room.
  Other active server sockets receive the same snapshot with `speaking:false`.
- A direct `voice:snapshot` acknowledgement follows the same rule: return full
  state only when that requesting socket is in the room, otherwise redact every
  member's speaking flag. Never forward RTC signaling unless sender and target
  are both active members of the same voice room.
- `connection:probe` is an authenticated ACK-only liveness event. It carries no
  data and must not bypass the existing Socket.IO session middleware.
- Kicks, bans, channel deletion, server deletion, explicit leave, and socket
  cleanup must remove affected voice/subscription state and notify clients with
  the existing typed reasons.

## Optional Third-Party Providers

Turnstile and analytics are operator options. Both are resolved at startup from
environment variables, both are published to the browser through `/api/config`,
and both need the response policy widened for the origins they use.

- Resolve a provider into *both* of its origins: the host serving its script and
  the host receiving its data. These coincide often enough to look like one
  field, and they are not the same thing. `src/analytics.ts` records where each
  provider reports; a provider added without that entry produces a deployment
  that loads its script and records nothing.
- Prefer pinning a tag's destination over letting it derive one. Where the
  provider accepts an explicit endpoint — a Umami `data-host-url`, a gtag
  `transport_url` — send the value the policy was built from, so the two cannot
  drift apart.
- Only replace a provider's default endpoints with an operator-supplied one
  where that tag has no other destination to fall back to. Otherwise allow both;
  a redundant origin costs nothing next to events dropped in the browser.
- Fail at startup on a half-configuration rather than degrading to a disabled
  provider. An operator who set two of three values wants the third, not
  silence.
- Keep the disabled path inert: with nothing configured, the emitted policy must
  be byte-identical to one from a build without the option, and no origin may
  leak into it.

## Server Verification

Run:

```sh
npm run test -w @voxly/server
npm run typecheck -w @voxly/server
npm run build -w @voxly/server
```

Realtime tests bind `127.0.0.1`; request local-listen permission in restricted
sandboxes instead of treating `listen EPERM` as an assertion failure.

Add migration coverage for schema evolution, HTTP tests for authorization and
response shape, and realtime tests for authoritative state and audience scope.
