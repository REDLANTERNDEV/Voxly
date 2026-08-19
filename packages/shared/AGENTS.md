# Shared Contract Instructions

These instructions apply to `packages/shared` in addition to the repository
root guidance.

## Purpose

`@voxly/shared` is the dependency-light contract package used by the browser and
server. It owns public DTOs, media state, Socket.IO event maps, acknowledgements,
stable error/reason unions, and the few pure rules every peer must apply the
same way. It must not import application code or browser- or server-only runtime
modules.

Keep it in the single `src/index.ts`. Consumers import the TypeScript source and
Node strips its types at runtime, and Node does not resolve a relative `.js`
specifier to a `.ts` file. A second module re-exported from the index would
type-check and build, then fail at server start with `ERR_MODULE_NOT_FOUND`.

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

## Invite Contract Invariants

- Invite creation uses independent `expiresInMinutes` and `maxUses` values.
  Finite values come only from the approved preset unions and `null` means the
  corresponding limit is unlimited; do not restore `expiresInHours`.
- Stored invite DTOs expose `maxUses` and `usedCount`. Public preview exposes
  `expiresAt` and `remainingUses`, using `null` for an unlimited value.
- Raw invite tokens remain creation-response-only. Listing, preview, realtime,
  and shared membership shapes must never gain a stored raw token.

## Voice Contract Invariants

- `VoiceJoinRequest` contains `roomId` and effective `VoiceMediaState`.
- `VoiceJoinAck` returns the authoritative `VoiceMemberState` or a stable error;
  the join event is acknowledged and is not a room-ID-only fire-and-forget call.
- Every `VoiceMemberState` includes independent owner `muted` and `deafened`
  moderation flags; do not infer them from self-managed media state.
- Deafen semantics remain consistent across packages: deafened state cannot
  coexist authoritatively with mic-on or speaking-on.
- Visual targets identify publisher and media kind. Subscription and signaling
  ACKs retain explicit authorization and availability failures.
- Force-leave reasons remain typed so UI recovery can distinguish room moves,
  moderation, and deleted resources without parsing messages.
- Connection health uses the typed ACK-only `connection:probe` event; it must
  not carry application data or weaken authenticated socket setup.
- `shouldInitiatePeerConnection` and `shouldIgnoreIncomingOffer` are defined
  here and nowhere else. Every peer applies them to the same pair of user ids,
  so a second copy that drifted would leave both sides waiting for an offer
  neither sends, or both discarding the other's. Signaling state crosses the
  boundary as `VoiceSignalingState`; do not narrow it back to the DOM's
  `RTCSignalingState`, which a peer outside a browser cannot produce.

## Verification

Types are the contract, so most of this package is verified by type-checking its
consumers. The exported rules are behavior and carry their own tests:

```sh
npm run test -w @voxly/shared
```

After a shared contract change, run all consumers:

```sh
npm run typecheck
npm test
```

Add or update server and web tests that exercise both serialization/production
and consumption of the changed contract.
