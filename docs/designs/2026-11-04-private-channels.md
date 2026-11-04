# Design — Private channels (2026-11-04)

Decision record: ADR-0037. Status: built (uncommitted, 2026-11-05).

## Context

Owners want some text and voice channels to be private: only chosen members can enter them, read and write for text, or join and talk for voice. Today nothing in Voxly scopes access below the Server. Every active Membership sees every channel, and three realtime broadcasts (`message:new`, `voice:joined`/`voice:left`, and the outside `voice:snapshot`) go to the whole Server.

Decisions settled with the user in the grilling (Q1–Q12, all recommendations accepted, plus the Listed clarification):

1. **Every Server owner** always has access to every private channel and can't be removed. The Installation owner gets nothing extra.
2. Privacy is set **per channel**. Categories carry no access of their own.
3. Access is a **per-member list** (an allowlist of Memberships). Roles are left for the levels/leagues effort, which can add a second kind of entry later.
4. A private channel is either **Hidden** or **Listed**:
   - **Hidden**: people without access don't know it exists.
   - **Listed**: view-only for people without access. For text, they can open it and read history, but can't send, react, edit or wave. For voice, they see the participants but can't join, and they **don't see the Call length**.
5. Being on the list means full ordinary member rights in that channel.
6. Access is checked when something is read, so it covers the **whole history**, including messages someone wrote before the channel became private.
7. Losing access while inside takes effect immediately:
   - voice: disconnected (`voice:forceLeave`, reason `room_access_revoked`)
   - Hidden text: moved off the channel
   - Listed text: becomes read-only
8. Owners can't **move** a member into a voice channel that member can't enter. The server refuses, and the menu doesn't offer it.
9. The **Music bot** needs no grant. A Summon by someone with access allows the bot into that channel for the Set. This isn't a branch on `is_bot`.
10. The **AFK room** and the **Welcome notice channel** can't be made private, in either direction.
11. **Channel** becomes the domain word. Code keeps `Room*` as legacy spelling, with no rename.

Choices I made for gaps the grilling didn't cover (open to change at approval):

- Kick, ban and Account deletion clear that Membership's grants, so re-joining never silently brings back old access.
- Bots can't be put on a list.
- People who can read a Listed channel get `message:new` and unread counts for it.
- Mentions and `@everyone`/`@here` in a private channel reach only people with access.
- Gaining access sets that member's read cursor to the latest message, so old history doesn't flood in as unread.
- Members with access receive the channel's access list, which the mention picker needs. Owners receive every list, which the move menu needs.

## Slice 0 — Design records (no product code)

- `docs/adr/0037-private-channels-are-checked-on-read.md`. Re-check the highest number first, because the B session may have added one. It records:
  - access is evaluated when read, not when written
  - owners can't be locked out
  - Hidden vs Listed, with Listed meaning view-only
  - a per-member allowlist now, extensible by roles later
  - the summon allowance in place of a bot grant
  - rejected options: per-message visibility, roles now, "listen-only" levels
- `docs/designs/2026-11-04-private-channels.md`: the problem, stories, surfaces, what was ruled out, and these slices.
- `CONTEXT.md`:
  - resolve **Room vs channel** in favour of Channel, and rewrite "voice room" as "voice channel" in the existing entries
  - add **Private channel**, **Channel access** (the list; avoid "whitelist", "permissions", "role"), and **Hidden** / **Listed**
  - amend **Call length**: it's visible to everyone who can enter the channel, and to everyone in the Server for a public one
- `AGENTS.md`:
  - a decision-ownership row for ADR-0037
  - rule bullets in `apps/server/AGENTS.md` (Messages and Rooms; Atomic Voice), `apps/web/AGENTS.md` (LIVE Watch and Voice Presentation; Member and Owner Surfaces) and `packages/shared/AGENTS.md`

## Slice 1 — Contract, schema, one access rule

- **`packages/shared/src/index.ts`**
  - `RoomSummary` gains:
    - `isPrivate: boolean`
    - `listed: boolean`
    - `canEnter: boolean`
    - `accessUserIds?: string[]`, sent only to viewers who can enter
  - add `RoomAccessUpdate { isPrivate; listed; userIds }`
  - add `room_access_revoked` to `VoiceForceLeaveReason`
  - no new shared error code: a refused join acknowledges the existing `forbidden` (or `room_not_found` for a Hidden channel), and a refused move answers HTTP 409 `room_forbidden`, which the client never triggers because its move menu offers only channels the member can enter
- **`apps/server/src/db/database.ts`**, additive only:
  - `addColumnIfMissing` for `rooms.is_private` and `rooms.listed`, both `integer not null default 0`
  - `create table if not exists room_access(room_id, user_id, granted_by_user_id, granted_at, primary key(room_id, user_id))`, with an index on `user_id`
  - mirror both in `db/schema.ts`
- **`apps/server/src/members.ts`**: one rule, built on `activeServerMembership` and `isServerOwner`:
  - `roomAccess(sqlite, room, userId) → { canSee, canRead, canEnter }`
  - `requireRoomRead` and `requireRoomEnter` reply helpers
  - `roomReaderIds` and `roomEntrantIds` (set helpers for audiences)
- **`apps/server/src/rooms.ts`**:
  - `RoomRow`, `roomColumns` and `publicRoom(row, viewer)` fill the new fields for each viewer
  - add `roomsVisibleTo(serverId, userId)`
- **`apps/server/src/servers.ts`**:
  - new owner route `PUT /api/servers/:serverId/rooms/:roomId/access`:
    - strips owners (they always have access) and refuses, with 400, anyone who is not an active human member, Bots included
    - refuses the AFK room or Welcome channel with 409
    - writes the list in one transaction with audit `room.accessChanged`, following the repo's camelCase audit names
    - sets the cursor baseline for new readers
    - calls `realtime.revokeRoomAccess`, then emits `server:roomsChanged`, so nobody is told of the new list while still inside a channel they lost
  - `GET` rooms (`:153`, legacy `:554`) and the `PATCH /layout` response filter through `roomsVisibleTo`
  - room delete and server delete also delete `room_access` rows
  - `chosenWelcomeRoom` / `welcomeRoomId` and the AFK choice skip private rooms
  - update the route-set assertion in `test/servers.test.ts`
- **Kick, ban and Account deletion** delete that Membership's `room_access` rows, in the existing transactions in `app.ts` (kick/ban) and `accountDeletion.ts`. The Installation-wide ban in `ownerPanel.ts` leaves them in place, like `can_invite`: a globally banned Account has no active Membership, so its grants are inert, and lifting the ban restores the person as they were.

## Slice 2 — Text gating

- `apps/server/src/messages.ts`:
  - `requireTextRoom` gains a mode:
    - **read** (history, context, pins list): `canRead`
    - **write** (send, wave, edit, reactions, embeds suppression, own delete, pin writes): `canEnter`
  - `prepareMentions` takes the room. `people`, `@everyone` and `@here` narrow to `roomEntrantIds`.
  - `message:new` (`:400`, `:482`, `:724`) goes through a new `emitNewMessage(io, sqlite, room, message)`:
    - a public or Listed channel emits to `server:`
    - a Hidden channel emits to the fetched server sockets whose user is in `roomReaderIds`
- `app.ts` `room:join` (`:904`) requires `canRead`.
- `notifications.ts`:
  - `notificationState` filters by `canRead`
  - `PUT read-state` requires `canRead`

## Slice 3 — Voice gating

- `voice.ts`:
  - `voice:join` (`:321`) requires `canEnter`, or a summon allowance for that room. A refusal acknowledges `forbidden`.
  - `voice:joined`/`voice:left` and the outside `voice:snapshot` go per audience:
    - Hidden: only sockets of entrants
    - Listed: all server sockets, with `callLengthMs` withheld from people who can't enter
    - public: as today
  - The direct `voice:snapshot` acknowledgement follows the same rules. Hidden with no access answers with an empty roster, exactly as a missing channel does (the acknowledgement has no error shape).
  - `voice:setMediaState` re-checks `canEnter`.
- **Summon allowance** (`music.ts` `forwardMusicCommand`, `:249`):
  - when a member with `canEnter` and in the channel sends a command, record that the Server's Music bot may join this room
  - the allowance is held in `VoiceContext` per bot as a set of channels, so a command for another channel never costs the bot its place; it survives a reconnect and is cleared when the bot leaves that channel on purpose (`voice:leave`) or the room is deleted
- **Move route** (`app.ts:719`): refuses a target who can't enter, with 409 before `moveMember`.
- `app.ts`, new `revokeRoomAccess(serverId, roomId, lostUserIds)`, modelled on `revokeServerAccess` (`:1033`):
  - if Hidden, their sockets leave `room:<id>`
  - `voice.forceLeave` with `room_access_revoked` for anyone in that voice room
  - re-emit the snapshot

## Slice 4 — Web

- `useWorkspaceController.refreshRooms` (`:129`): if the viewed text or voice route's room is no longer in the response, navigate away. This generalises `deletedRoomId`.
- `Icons.tsx`: add a new `LockIcon` (inline SVG, `currentColor`, `aria-hidden`), and add it to `test/app-source.ts`.
- `ChannelRail.tsx`:
  - a private row shows the lock in the muted rail colour, with `sr-only` "Private channel"
  - a voice row with `!canEnter`:
    - `activateVoiceRoom` never joins it; it gets `aria-disabled` and a "You don't have access" title
    - participants are still listed
    - no `CallLength`
    - no member actions beyond today's observer rules
  - the channel menu gains "Channel access…" for owners. Raise `channelActionMenuHeight`.
- New `features/owner/ChannelAccessDialog.tsx`, modelled on `ChannelNameDialog` (`Dialogs.tsx:175`):
  - a Private switch, and a Hidden / Visible-to-others (view only) choice
  - a searchable checklist from the member-safe directory (`serverMembersByServer`), with owners shown as checked and locked, and bots left out
  - AFK and Welcome channels show a disabled switch with the reason
  - saves through a new `updateRoomAccess` in `api.ts`, then refreshes
- Text screen (`TextRoomScreen.tsx` / composer / `MessageItem.tsx`):
  - when `!canEnter`, show a read-only notice in place of the composer, and hide react, edit, reply and wave actions
  - the mention picker (`mentionCandidates`) is narrowed to `accessUserIds` plus owners in private channels
- Move targets (`ChannelRail.tsx:350`, `MemberPanel.tsx:176`, `StageMemberActions.tsx:132`): one helper `canMemberEnter(room, member)` in `lib/memberDirectory.ts`. Update the regexes in `test/member-move.test.ts`.
- `OwnerServerContext.tsx`: the AFK and Welcome selects leave out private channels.
- `presentation.tsx` `forceLeaveNoticeKey`: add `room_access_revoked`.
- `i18n.ts`: every new string added in both `en` and `tr`.

## Tests

- **Server**: a new `apps/server/test/private-channels.test.ts`, using the HTTP + realtime helpers from `realtime.test.ts`:
  - the access route is owner-only, validated, audited, and refuses AFK and Welcome channels
  - Hidden is missing from the list and returns 403/404 on every text route; Listed reads but refuses writes
  - mentions and `@everyone` stay within the list
  - unread state is filtered
  - `message:new` doesn't reach outsiders of a Hidden channel
  - voice: join refused, snapshot audiences, Call length withheld in Listed, move refused, forced leave on revoke
  - the summon allowance lets the bot in
  - kick clears grants
  - a migration test on a legacy DB file
- **Unit**: `roomAccess` in `test/members.test.ts`.
- **Web**: presentation tests (lock and accessible name, locked voice row, no Call length, read-only composer), the access dialog, the move-target filter, and i18n coverage. Update `RoomSummary` fixtures such as `channel-presentation.test.tsx`.

## Verification

- `npm run typecheck && npm test` at the root, since this is a shared contract change.
- Rerun the bot mesh tests alone if they flake on this Mac (known).
- Browser check through `preview_start`:
  - owner makes a channel Hidden, then Listed, and edits the list
  - a second member account sees the lock, read-only text and the locked voice row
  - join voice from a mic-less socket script (the Browser pane blocks the mic), then revoke and watch the forced leave
  - check desktop and narrow widths
- `git status --short`, then `git diff --check`. Commit nothing; the user commits.
- Tell the user what is still unverified. After the build, `/to-tickets` is optional, since the work will already be done.
