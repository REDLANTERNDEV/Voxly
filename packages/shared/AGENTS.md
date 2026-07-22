# Shared Contract Instructions

These instructions apply to `packages/shared` in addition to the repository
root guidance.

## Purpose

`@voxly/shared` is the dependency-light contract package used by the browser and
server. It owns public DTOs, media state, Socket.IO event maps, acknowledgements,
and stable error/reason unions. It must not import application code or browser-
or server-only runtime modules.

## Contract Rules

- Treat exported types as cross-package interfaces, not local implementation
  details. Search both applications and all tests before changing a field,
  union member, event argument, or acknowledgement.
- Update producer and consumer in the same change. A shared type change is not
  complete when only TypeScript compiles on one side.
- Prefer explicit interfaces and discriminated unions. Success and failure ACKs
  must remain distinguishable by `ok` and expose stable finite error codes.
- Keep server-scoped identifiers on DTOs and events when consumers need them to
  reject stale or cross-server state.
- Do not weaken a required field to optional merely to ease a migration. Define
  an explicit compatibility path when older wire formats must be supported.
- Keep sensitive server-only fields out of public DTOs. Directory and presence
  users expose identity, nickname, and role—not token, session, moderation, or
  database internals.
- Server nickname changes reuse `PresenceUser` and a typed event carrying both
  `serverId` and the updated user. Producers must scope the event to that server;
  consumers must apply it only to server-indexed presence, voice, directory,
  and message caches.
- Server name changes use `server:updated` with the exact payload
  `{ serverId: string; name: string }`. Producers emit it only after persistence
  and only to the renamed server room; consumers update only the matching
  `ServerSummary` so unrelated server options and memberships remain intact.
- `ChatMessage.suppressedEmbedKeys` is a required bounded list produced for
  history, creation, and `message:updated` deliveries. Consumers derive rich
  previews from the plain message body and omit only matching keys; do not add
  provider HTML or fetched metadata to the shared message contract.

## Voice Contract Invariants

- `VoiceJoinRequest` contains `roomId` and effective `VoiceMediaState`.
- `VoiceJoinAck` returns the authoritative `VoiceMemberState` or a stable error;
  the join event is acknowledged and is not a room-ID-only fire-and-forget call.
- Deafen semantics remain consistent across packages: deafened state cannot
  coexist authoritatively with mic-on or speaking-on.
- Visual targets identify publisher and media kind. Subscription and signaling
  ACKs retain explicit authorization and availability failures.
- Force-leave reasons remain typed so UI recovery can distinguish room moves,
  moderation, and deleted resources without parsing messages.

## Verification

The package has type-checking but no standalone runtime test suite. After a
shared contract change, run all consumers:

```sh
npm run typecheck
npm test
```

Add or update server and web tests that exercise both serialization/production
and consumption of the changed contract.
