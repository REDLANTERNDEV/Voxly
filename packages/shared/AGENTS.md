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
- `MusicCommand` is a discriminated union on `kind`, because the verbs that
  carry data carry different data: `add` names what a member typed, `skip` and
  `remove` name a Queue entry, and `play`, `stop` and `leave` name nothing. Do
  not flatten it back to a verb plus optional fields — each one would be
  optional everywhere in order to be absent in most cases, and nothing would
  then stop a `stop` arriving with a link on it. A new verb that needs data is a
  new member here.
- **`add` carries a link or a name on one field, and the bot decides which.**
  `input` is what a member typed. Do not split it into two verbs or two
  controls, and do not have the browser route on the string's shape: "is this a
  link" and "is this a link I can play" are answered by the same host list in
  `apps/bot/src/track.ts`, and half a rule in a process that cannot see the
  other half is the copy that drifts. ADR-0007. `musicInputMaxLength` bounds it
  — one bound for the link, the name and the link a chosen Result hands back,
  because they arrive on the same field.
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
- A success is `MusicAnswer`, a union discriminated on `kind`, shared by both
  acknowledgements so there is one shape for "it worked". `kind: "track"`
  carries `track`, explicitly `null` for a request that produces none — not
  optional: a consumer that forgets to handle "there is no Track" should have to
  say so. `kind: "results"` carries what a typed name found. Do not collapse
  these into one shape with two nullable fields; that is the same mistake the
  command union already refuses, and it leaves nothing to stop an answer
  arriving as both or as neither.
- **A Result is the one thing on this wire that is not the room's.** It travels
  back on the acknowledgement to the single socket that asked, never through
  `music:publish` and never inside `MusicQueueState`. The rule beside it — the
  Queue travels whole, so five members see one list — is the *opposite* rule and
  the next person will read it first: ADR-0007 records why a list a member is
  still choosing from belongs to that member alone. `musicSearchResultsMax`
  bounds the count and `musicTitleMaxLength` bounds each title and channel,
  because a title is somebody else's string arriving unbidden and a list of them
  is that problem several times over.
- `MusicSearchResult.url` is the canonical link the *bot* built, handed back
  unread by the browser on the same `add` a paste uses. The browser never
  constructs a link of its own, and the bot re-reads this one exactly as it
  reads a pasted one — nothing is trusted for having been round the loop.
- Which links are playable — and whether an input is a link at all rather than a
  name to search for — is the bot's knowledge and lives in `apps/bot`. The
  server bounds the input's length and nothing else, and the browser checks only
  that the field is not empty. A second opinion in either place would be the
  copy that drifts, refusing a form the bot has since learned to accept.
- **The Queue travels one way and whole.** `music:publish` is the bot asking the
  server to give a room its Queue; `music:queue` is the server giving it. Both
  carry the entire `MusicQueueState`, never a delta — a room where two members
  disagree about what is coming next is the failure this contract prevents, and
  a delta that went missing is exactly how that happens. The Queue is bounded
  (`musicQueueMaxEntries`) so sending all of it stays cheap. ADR-0005 records
  why the shape is a request the server authorizes rather than a relay.
- **The Set log travels on `MusicQueueState`, not beside it.** Every line is
  produced by a change that was already publishing the Queue, so a second
  payload would add no message and would buy the failure this contract exists to
  prevent: a line saying a Track was skipped, delivered to a room still holding
  it. `musicSetLogMaxLines` bounds the count and `musicTitleMaxLength` bounds the
  title on each line, for the same reason the Queue's are bounded — it is the
  source's string, relayed whole to every browser in the channel. ADR-0008.
- `MusicSetLogLine.requestedByUserId` is an id, resolved at the browser's end,
  under exactly the rule the Queue entry below states — and it names the member
  who asked for *that* action, not the Requester of the Track it was about. The
  Track is carried as a **title** rather than an `entryId`, because the point of
  most lines is that the entry has gone and there is nothing left to look it up
  in. `trackTitle` is explicitly `null` for a pause and a resume rather than
  absent, as `MusicAnswer`'s `track` is.
- `MusicSetLogAction` is the closed list of things a member can be said to have
  done. A Track ending is not one of them — the log names who did something, and
  nobody did that. A verb added here must be added to the server's validator and
  to the browser's mapping; both are exhaustive so the build says so.
- `MusicQueueEntry.requestedByUserId` is an id, and no nickname belongs beside
  it. The bot is handed ids and never sees a member list; every browser already
  holds the room's members and renders their current names. A nickname copied on
  here is the copy that goes stale when somebody renames themselves.
- `entryId` identifies the entry, not the Track. Two members queueing the same
  link are two entries, and either can be skipped or removed without the other
  going with it. It is meaningless outside the Set that minted it.
- **`skip` and `remove` carry the entry they mean, and are two verbs on purpose.**
  Naming an entry rather than a position is what makes two members pressing skip
  at the same moment cost one Track: the second request finds the Track it named
  already gone and succeeds without advancing. They stay apart because a skip
  may only move past the *head* while a removal takes out the entry it names
  wherever it sits — so a stale Skip press can never delete a Track somebody is
  still waiting for. ADR-0006 records both.
- One bound for every opaque identifier on this wire (`musicIdentifierMaxLength`)
  — the `entryId`, the source's id for a Track, the Requester's user id. They
  are the same kind of thing to everyone handling them, and a second constant
  beside it is the one that drifts.
- `MusicQueueState.playing` is what says whether the head of the Queue is
  sounding. A consumer that renders the first entry as playing without reading
  it announces a Track into a silent room.

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
