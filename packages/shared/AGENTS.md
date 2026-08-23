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
  `RTCSignalingState`, which a peer outside a browser cannot produce. "Every
  peer" includes the Music bot: it is a peer in the mesh, not a special case
  (ADR-0001).

## Music Contracts

- `music:control` is one event carrying a `MusicCommand`, not one event per
  verb. Every one of them is the same request — this room, this instruction —
  and the transport rules do not vary between them. Extend the union rather than
  adding an event beside it.
- `MusicCommand` is a discriminated union on `kind`, because `add` carries the
  link it names and the others carry nothing. Do not flatten it back to a verb
  plus an optional `url`: that makes the field optional everywhere in order to
  be absent in three cases out of four, and nothing then stops a `stop` arriving
  with a link on it. A new verb that needs data is a new member here.
- `music:command` is server-to-client and is only ever delivered to a Music bot
  account. It carries the room the request names, so a command that raced a move
  can be ignored rather than applied to the wrong Set. It is delivered to one
  socket, the most recent, rather than to every socket the account holds —
  two deliveries would summon two Sets into the same room.
- **The bot's answer is relayed to the member, not absorbed.** `music:command`
  is acknowledged, the server waits for that acknowledgement, and
  `MusicControlAck` carries whichever answer came back. Only the bot can tell
  whether a link resolves to something playable, and the alternative for someone
  who pasted a dead one is silence — the worst possible answer from a control
  whose only output is sound somewhere else.
- Every refusal in `MusicControlError` gets its own sentence in both languages,
  and the browser's mapping is exhaustive on purpose: adding a member here
  should fail the build rather than quietly render the wrong sentence. Keep the
  ones that lead somewhere different apart — `no_music_bot` from `bot_offline`,
  `unsupported_link` from `track_unavailable` from `extractor_failed` — because
  only some of them are worth waiting out and only some of them mean the link
  was the problem.
- A successful `MusicControlAck` carries `track`, explicitly `null` for a
  request that produces none. Not optional: a consumer that forgets to handle
  "there is no Track" should have to say so.
- Which links are playable is the bot's knowledge and lives in `apps/bot`. The
  server bounds the link's length and nothing else, and the browser checks only
  that the field is not empty. A second opinion in either place would be the
  copy that drifts, refusing a form the bot has since learned to accept.

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
