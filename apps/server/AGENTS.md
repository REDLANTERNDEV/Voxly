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
- Operations described as atomic must complete their related validation and
  writes before publishing realtime state. Avoid partial external visibility.
- Never commit generated `.sqlite`, `-shm`, or `-wal` files.

## Authentication and Sensitive Tokens

- Invite, session, access-claim, and owner-claim tokens are stored only as
  hashes. Do not log or persist raw values.
- An authenticated active member may reopen the exact invite that they
  previously consumed. Return `already_server_member` with that invite's
  `serverId` without restoring or changing membership.
- Keep every other unknown, expired, consumed, revoked, or orphaned invite
  response generic. A token consumed by a different user must not disclose its
  server or consumption state.
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
- Accepting a valid invite as an existing active member returns the target
  `serverId` and leaves that unused invite unused. Reopening a previously
  consumed invite never restores a removed or banned membership.
- Kicking sets `removed_at`, revokes effective access, disconnects realtime
  membership, and excludes the user from owner member lists. A kicked user may
  return through the existing invite flow.
- Banning is distinct from kicking. Banned users remain visible to owners so
  they can be unbanned, and existing sessions must not restore access.
- The member directory is available to active members and exposes only active
  users' `userId`, `nickname`, and `role`. Omit banned/removed memberships and
  all moderation/session fields.
- Membership changes emit the existing directory/access events to the correct
  server rooms. Do not broadcast server-scoped data globally.
- Preserve exact-name destructive confirmation at the client and enforce final
  owner-server/channel protections on the server.
- Server deletion remains atomic while preserving global identities and audit
  history that other servers still need.
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
- Room and server deletion must remove or invalidate dependent live state and
  notify affected clients without leaking events to unrelated servers.

## Atomic Voice and Realtime State

- `voice:join` accepts a typed `VoiceJoinRequest` and requires an ACK. Do not
  accept the legacy room-ID-only form.
- Validate that the target is an existing voice room and that the user has
  active access before changing membership.
- Normalize requested media before storing it: `deafened: true` forces
  `mic: false`; either mic-off or deafen forces `speaking: false`; every new
  membership starts with `speaking: false`.
- Build the ACK and emitted snapshot from the same authoritative
  `VoiceMemberState`. Never publish a temporary default `mic: true` state.
- A user account remains in at most one voice room globally. Moving rooms must
  clean the previous membership and visual subscriptions.
- Keep visual publisher limits and subscription authorization server-side.
  Signals are forwarded only between active members of the same voice room.
- Kicks, bans, channel deletion, server deletion, explicit leave, and socket
  cleanup must remove affected voice/subscription state and notify clients with
  the existing typed reasons.

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
