# Voice Sidebar and Server Nicknames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voice-room entry discoverable, align voice sidebar icons and menus, and add realtime server-specific nickname management.

**Architecture:** Store an optional nickname override on each server membership and resolve it at every server-scoped HTTP and realtime boundary. Reuse the acknowledged atomic voice join for channel activation, placing a pure decision helper between channel clicks and UI orchestration. Extend the existing portal menu and modal patterns instead of adding dependencies or a second overlay coordinator.

**Tech Stack:** Node.js 22, npm workspaces, strict TypeScript/ESM, Fastify, SQLite/Drizzle, Socket.IO, React 19, Vite, Node test runner, CSS.

## Global Constraints

- Preserve the existing user change in `.gitignore`; do not edit, stage, or revert it.
- Do not stage or commit any file unless the user explicitly requests it.
- Do not add a runtime, icon, menu, state-management, or media dependency.
- Add behaviorally equivalent English and Turkish copy in the same change.
- Keep owner authorization server-side and server-scoped.
- Keep voice joins on the existing acknowledged `voice:join` request.
- Preserve keyboard, touch, Escape, focus restoration, reduced-motion, and screen-reader behavior.
- Keep member volume listener-owned, integer-clamped, persisted per listener, and limited to `0%` through `200%`.
- Use inline React SVG with `currentColor` for functional icons.
- Keep SQLite evolution additive and compatible with existing databases.

---

## File Map

- `packages/shared/src/index.ts`: typed `server:memberUpdated` event contract.
- `apps/server/src/db/schema.ts`: nullable membership nickname metadata.
- `apps/server/src/db/database.ts`: additive migration.
- `apps/server/src/serverNicknames.ts`: effective server identity lookup helpers.
- `apps/server/src/app.ts`: scoped queries, rename endpoint, realtime identity refresh, message production.
- `apps/server/test/app.test.ts`: migration, authorization, isolation, and message regression coverage.
- `apps/server/test/realtime.test.ts`: server-scoped rename event and voice snapshot coverage.
- `apps/web/src/api.ts`: nickname update request.
- `apps/web/src/lib/memberIdentity.ts`: immutable client cache updates for a server member rename.
- `apps/web/src/lib/voiceChannelActivation.ts`: pure join/open/confirm decision.
- `apps/web/src/lib/i18n.ts`: English and Turkish UI copy.
- `apps/web/src/lib/voiceControls.ts`: compact mute/deafen ordering.
- `apps/web/src/App.tsx`: nickname dialogs and menu actions, realtime cache updates, voice channel activation, icons.
- `apps/web/src/styles.css`: dialog/menu sizing and screen icon stroke parity.
- `apps/web/test/member-identity.test.ts`: cache update isolation.
- `apps/web/test/voice-channel-activation.test.ts`: pure voice click decisions.
- Existing web source tests: menu, translation, voice rail, and screen icon contracts.

---

### Task 1: Add Server Nickname Persistence and Identity Helpers

**Files:**
- Modify: `apps/server/src/db/schema.ts:52-66`
- Modify: `apps/server/src/db/database.ts:130-180`
- Create: `apps/server/src/serverNicknames.ts`
- Modify: `apps/server/test/app.test.ts:20-85`

**Interfaces:**
- Produces: `serverPresenceUser(sqlite: DatabaseSync, serverId: string, userId: string): PresenceUser | null`
- Produces: `serverPresenceUsers(sqlite: DatabaseSync, serverId: string, userIds: Iterable<string>): PresenceUser[]`
- Produces: nullable SQL column `server_members.nickname`

- [ ] **Step 1: Extend the legacy migration test before changing the schema**

Add these assertions to the existing legacy migration test after reading `server_members`:

```ts
const memberColumns = tables.prepare("pragma table_info(server_members)").all()
  .map((column) => (column as { name: string }).name);
assert.ok(memberColumns.includes("nickname"));
assert.equal(
  tables.prepare("select nickname from server_members where user_id = 'owner'").get()?.nickname,
  null
);
```

- [ ] **Step 2: Run the server test and verify the new assertion fails**

Run: `npm run test -w @voxly/server`

Expected: FAIL because `server_members` does not contain `nickname`.

- [ ] **Step 3: Add the nullable schema field and additive migration**

In `apps/server/src/db/schema.ts`, add:

```ts
nickname: text("nickname"),
```

to `serverMembers`. In the `create table if not exists server_members` SQL add:

```sql
nickname text,
```

and after the existing migration calls add:

```ts
addColumnIfMissing(sqlite, "server_members", "nickname", "text");
```

- [ ] **Step 4: Add focused server identity helpers**

Create `apps/server/src/serverNicknames.ts`:

```ts
import type { PresenceUser } from "@voxly/shared";
import type { DatabaseSync } from "node:sqlite";
import { all, one } from "./db/database.js";

export function serverPresenceUser(
  sqlite: DatabaseSync,
  serverId: string,
  userId: string
): PresenceUser | null {
  return one<PresenceUser>(
    sqlite,
    `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ? and server_members.user_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null`,
    [serverId, userId]
  ) ?? null;
}

export function serverPresenceUsers(
  sqlite: DatabaseSync,
  serverId: string,
  userIds: Iterable<string>
): PresenceUser[] {
  const activeIds = new Set(userIds);
  if (activeIds.size === 0) return [];
  return all<PresenceUser>(
    sqlite,
    `select users.id as userId,
      coalesce(server_members.nickname, users.nickname) as nickname,
      server_members.role
     from server_members
     join users on users.id = server_members.user_id
     where server_members.server_id = ?
       and server_members.banned_at is null
       and server_members.removed_at is null
     order by nickname asc`,
    [serverId]
  ).filter((user) => activeIds.has(user.userId));
}
```

- [ ] **Step 5: Run focused verification**

Run:

```sh
npm run test -w @voxly/server
npm run typecheck -w @voxly/server
```

Expected: both commands PASS.

---

### Task 2: Add the Owner Rename API and Effective HTTP Queries

**Files:**
- Modify: `apps/server/src/app.ts:420-590, 650-840, 1380-1695`
- Modify: `apps/server/test/app.test.ts`

**Interfaces:**
- Consumes: `serverPresenceUser(...)` from Task 1.
- Produces: `PATCH /api/servers/:serverId/members/:userId/nickname` with body `{ nickname: string }` and response `{ user: PresenceUser }`.
- Produces stable errors: `member_not_found`, `cannot_rename_owner`, and Zod validation response for invalid nicknames.

- [ ] **Step 1: Write failing authorization, isolation, and message tests**

Add one HTTP test that creates an owner, a member, and a second server membership, then asserts:

```ts
const renamed = await app.server.inject({
  method: "PATCH",
  url: `/api/servers/${defaultServerId}/members/${member.user.id}/nickname`,
  cookies: owner.cookies,
  payload: { nickname: "  Basement Ece  " }
});
assert.equal(renamed.statusCode, 200);
assert.equal(renamed.json().user.nickname, "Basement Ece");

const directory = await app.server.inject({
  method: "GET",
  url: `/api/servers/${defaultServerId}/directory`,
  cookies: member.cookies
});
assert.equal(
  directory.json().members.find((user: { userId: string }) => user.userId === member.user.id).nickname,
  "Basement Ece"
);
```

In the same test, verify a server where no override was written still returns the account nickname. Add separate requests asserting a normal member receives `403`, a removed target receives `404`, an invalid one-character nickname receives `400`, and the owner can rename its own membership.

After creating a message before the rename, assert both history and a later edit return `Basement Ece` for that `userId`.

- [ ] **Step 2: Run the server suite and verify the new HTTP test fails**

Run: `npm run test -w @voxly/server`

Expected: FAIL with `404` for the missing nickname route.

- [ ] **Step 3: Add the owner-authorized endpoint**

Add a route beside the existing member moderation route:

```ts
server.patch("/api/servers/:serverId/members/:userId/nickname", async (request, reply) => {
  const owner = requireOwner(database, request, reply, options.secureCookies);
  if (!owner) return;
  const { serverId, userId } = z.object({
    serverId: z.string().min(1),
    userId: z.string().uuid()
  }).parse(request.params);
  const { nickname } = z.object({ nickname: nicknameSchema }).parse(request.body);
  if (!requireServerOwner(database, serverId, owner.id, reply)) return;
  const target = serverMembership(database.sqlite, serverId, userId);
  if (!target || target.removed_at) {
    return reply.code(404).send({ error: "member_not_found" });
  }
  if (target.role === "owner" && userId !== owner.id) {
    return reply.code(409).send({ error: "cannot_rename_owner" });
  }
  run(database.sqlite,
    "update server_members set nickname = ? where server_id = ? and user_id = ?",
    [nickname, serverId, userId]
  );
  audit(database, owner.id, "member.nickname_updated", userId, serverId);
  database.save();
  const user = serverPresenceUserIncludingBanned(database.sqlite, serverId, userId);
  return { user };
});
```

Implement `serverPresenceUserIncludingBanned` in `serverNicknames.ts` with the same `coalesce` query but only `removed_at is null`, because banned members remain owner-visible.

- [ ] **Step 4: Apply effective nicknames to HTTP producers**

Change directory and owner-member queries to select:

```sql
coalesce(server_members.nickname, users.nickname) as nickname
```

Change message history and `messageById` to join `rooms`, `server_members`, and `users`:

```sql
join rooms on rooms.id = messages.room_id
join server_members
  on server_members.server_id = rooms.server_id
 and server_members.user_id = messages.user_id
join users on users.id = messages.user_id
```

and select the same `coalesce` expression. When creating a message, use:

```ts
const sender = serverPresenceUser(database.sqlite, room.serverId, user.id);
if (!sender) return reply.code(403).send({ error: "server_forbidden" });
const message = {
  id: crypto.randomUUID(),
  roomId,
  userId: user.id,
  nickname: sender.nickname,
  body: body.body,
  createdAt: new Date().toISOString(),
  editedAt: null
};
```

- [ ] **Step 5: Run server HTTP verification**

Run:

```sh
npm run test -w @voxly/server
npm run typecheck -w @voxly/server
```

Expected: both commands PASS, including legacy migration and nickname isolation.

---

### Task 3: Publish Server-Scoped Realtime Identity Updates

**Files:**
- Modify: `packages/shared/src/index.ts:96-130`
- Modify: `apps/server/src/app.ts:100-120, 880-1235, 1435-1460`
- Modify: `apps/server/test/realtime.test.ts`

**Interfaces:**
- Consumes: nickname endpoint and identity helpers from Tasks 1-2.
- Produces: `ServerToClientEvents["server:memberUpdated"]` payload `{ serverId: string; user: PresenceUser }`.
- Produces: `RealtimeModeration.refreshMemberIdentity(serverId: string, userId: string): PresenceUser | null`.

- [ ] **Step 1: Write failing realtime scoping and voice tests**

Create two servers, connect owner/member sockets, join the member to a voice room, and listen for:

```ts
const updatedPromise = onceEvent<{
  serverId: string;
  user: { userId: string; nickname: string };
}>(memberSocket, "server:memberUpdated");
const snapshotPromise = onceEvent<{
  roomId: string;
  members: Array<{ user: { userId: string; nickname: string } }>;
}>(memberSocket, "voice:snapshot");
```

Rename the membership through HTTP, then assert the event and snapshot both contain the new nickname. Connect a socket that belongs only to the other server and assert `expectNoEvent(otherSocket, "server:memberUpdated")`.

- [ ] **Step 2: Run the server suite and verify contract failure**

Run: `npm run test -w @voxly/server`

Expected: TypeScript build FAILS because `server:memberUpdated` is not in `ServerToClientEvents`.

- [ ] **Step 3: Add the shared event contract**

In `packages/shared/src/index.ts`, add:

```ts
"server:memberUpdated": (payload: { serverId: string; user: PresenceUser }) => void;
```

- [ ] **Step 4: Make realtime identities server-specific**

Change `serverPresenceUsers` in `app.ts` to pass online user IDs through the Task 1 helper. During connection, derive an effective user separately for every `serverId` before emitting `presence:serverOnline`. During `voice:join`, derive:

```ts
const roomUser = serverPresenceUser(database.sqlite, room.serverId, user.userId);
if (!roomUser) {
  ack({ ok: false, error: "forbidden" });
  return;
}
const state: VoiceMemberState = { user: roomUser, media };
```

Do not mutate the socket's global authentication identity.

- [ ] **Step 5: Add authoritative in-memory refresh**

Extend `RealtimeModeration` and its implementation:

```ts
refreshMemberIdentity(serverId, userId) {
  const updated = serverPresenceUserIncludingBanned(database.sqlite, serverId, userId);
  if (!updated) return null;
  for (const [roomId, members] of voiceMembership) {
    const room = roomById(database.sqlite, roomId);
    const current = members.get(userId);
    if (!room || room.serverId !== serverId || !current) continue;
    members.set(userId, { ...current, user: updated });
    emitVoiceSnapshot(io, database, roomId, members);
  }
  io.to(`server:${serverId}`).emit("server:memberUpdated", { serverId, user: updated });
  return updated;
}
```

Call `realtime.refreshMemberIdentity(serverId, userId)` from the nickname endpoint after `database.save()` and return its user. Active/banned handling must still prevent banned users from appearing in presence while allowing the owner response.

- [ ] **Step 6: Run shared and server verification**

Run:

```sh
npm run typecheck -w @voxly/shared
npm run test -w @voxly/server
npm run typecheck -w @voxly/server
```

Expected: all commands PASS.

---

### Task 4: Update Client Identity Caches and API Boundaries

**Files:**
- Create: `apps/web/src/lib/memberIdentity.ts`
- Create: `apps/web/test/member-identity.test.ts`
- Modify: `apps/web/src/api.ts:180-205`
- Modify: `apps/web/src/App.tsx:170-265, 535-610, 730-815, 945-990`

**Interfaces:**
- Produces: `updateServerMemberNickname(serverId: string, userId: string, nickname: string): Promise<{ user: PresenceUser }>`.
- Produces: `replacePresenceUser(users: PresenceUser[], next: PresenceUser): PresenceUser[]`.
- Produces: `renameMessagesForServer(messagesByRoom, roomServerIds, serverId, user): Record<string, ChatMessage[]>`.
- Produces: `ShellProps.onUpdateMemberNickname(userId, nickname): Promise<PresenceUser>` and `ShellProps.currentNickname: string`.

- [ ] **Step 1: Write cache-isolation tests**

Create `apps/web/test/member-identity.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameMessagesForServer, replacePresenceUser } from "../src/lib/memberIdentity.js";

describe("server member identity updates", () => {
  it("replaces one presence user without duplicating it", () => {
    assert.deepEqual(
      replacePresenceUser(
        [{ userId: "u1", nickname: "Old", role: "member" }],
        { userId: "u1", nickname: "New", role: "member" }
      ),
      [{ userId: "u1", nickname: "New", role: "member" }]
    );
  });

  it("renames loaded messages only in the target server", () => {
    const messages = {
      roomA: [{ id: "a", roomId: "roomA", userId: "u1", nickname: "Old", body: "A", createdAt: "now", editedAt: null }],
      roomB: [{ id: "b", roomId: "roomB", userId: "u1", nickname: "Old", body: "B", createdAt: "now", editedAt: null }]
    };
    const renamed = renameMessagesForServer(messages, { roomA: "server-a", roomB: "server-b" }, "server-a", {
      userId: "u1", nickname: "New", role: "member"
    });
    assert.equal(renamed.roomA[0].nickname, "New");
    assert.equal(renamed.roomB[0].nickname, "Old");
  });
});
```

- [ ] **Step 2: Run the new web test and verify it fails**

Run: `npm run test -w @voxly/web`

Expected: FAIL because `src/lib/memberIdentity.ts` does not exist.

- [ ] **Step 3: Implement immutable identity helpers**

Create `apps/web/src/lib/memberIdentity.ts`:

```ts
import type { ChatMessage, PresenceUser } from "@voxly/shared";

export function replacePresenceUser(users: PresenceUser[], next: PresenceUser) {
  return users.some((user) => user.userId === next.userId)
    ? users.map((user) => user.userId === next.userId ? next : user)
    : [...users, next];
}

export function renameMessagesForServer(
  messagesByRoom: Record<string, ChatMessage[]>,
  roomServerIds: Record<string, string>,
  serverId: string,
  user: PresenceUser
) {
  return Object.fromEntries(Object.entries(messagesByRoom).map(([roomId, messages]) => [
    roomId,
    roomServerIds[roomId] === serverId
      ? messages.map((message) => message.userId === user.userId
        ? { ...message, nickname: user.nickname }
        : message)
      : messages
  ]));
}
```

- [ ] **Step 4: Add the typed API call**

In `apps/web/src/api.ts`:

```ts
export async function updateServerMemberNickname(serverId: string, userId: string, nickname: string) {
  return request<{ user: PresenceUser }>(
    `/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/nickname`,
    { method: "PATCH", body: JSON.stringify({ nickname }) }
  );
}
```

- [ ] **Step 5: Wire the realtime event into server-scoped caches**

Add a room index ref and call `indexRooms(response.rooms)` immediately before each full `setRooms(response.rooms)` or `setRooms(roomResponse.rooms)`. Add the created room in `onCreateRoom` as well:

```ts
const roomServerIdsRef = useRef<Record<string, string>>({});
const indexRooms = useCallback((nextRooms: RoomSummary[]) => {
  for (const room of nextRooms) roomServerIdsRef.current[room.id] = room.serverId;
}, []);
```

Handle `server:memberUpdated` by updating only `onlineUsersByServer[serverId]`, `serverMembersByServer[serverId]`, and message entries belonging to that server through the new helpers. Define:

```ts
const currentNickname = serverMembers.find((member) => member.userId === user.id)?.nickname
  ?? onlineUsers.find((member) => member.userId === user.id)?.nickname
  ?? user.nickname;
```

Pass `currentNickname` and an `onUpdateMemberNickname` callback through `ShellProps`. The callback calls the API and applies the same cache update immediately; the realtime event remains idempotent.

- [ ] **Step 6: Run client boundary verification**

Run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
```

Expected: both commands PASS.

---

### Task 5: Add Accessible Nickname Editing to Existing Menus

**Files:**
- Modify: `apps/web/src/lib/i18n.ts`
- Modify: `apps/web/src/App.tsx:1378-1590, 1765-2218, 2229-2280`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/test/i18n.test.ts`
- Modify: `apps/web/test/sidebar-context-menu.test.ts`
- Modify: `apps/web/test/member-volume-menu.test.ts`

**Interfaces:**
- Consumes: `ShellProps.onUpdateMemberNickname` and `currentNickname` from Task 4.
- Produces: reusable `NicknameDialog` with `{ user, onCancel, onSave, t }`.

- [ ] **Step 1: Add failing translation and source-contract tests**

Assert English and Turkish values for these keys:

```ts
"member.changeNickname"
"member.nicknameLabel"
"member.nicknameUpdated"
"member.nicknameUpdateFailed"
"member.nicknameLength"
```

Extend sidebar tests to require `RailMemberActionControl` and `MemberPanel` to render `member.changeNickname` only when `canRename` is true, and to retain `VolumeControl` only for remote active voice users. Extend the owner table source test to require a nickname action for both the owner row and normal member rows.

- [ ] **Step 2: Run web tests and verify missing-copy failure**

Run: `npm run test -w @voxly/web`

Expected: FAIL because the new translation keys and nickname dialog are absent.

- [ ] **Step 3: Add equivalent English and Turkish strings**

Use these values:

```ts
// English
"member.changeNickname": "Change nickname",
"member.nicknameLabel": "Nickname",
"member.nicknameUpdated": "Nickname updated.",
"member.nicknameUpdateFailed": "Nickname could not be updated.",
"member.nicknameLength": "Use between 2 and 32 characters.",

// Turkish
"member.changeNickname": "Takma adı değiştir",
"member.nicknameLabel": "Takma ad",
"member.nicknameUpdated": "Takma ad güncellendi.",
"member.nicknameUpdateFailed": "Takma ad güncellenemedi.",
"member.nicknameLength": "2 ile 32 karakter arasında kullanın.",
```

- [ ] **Step 4: Implement `NicknameDialog`**

Use the existing modal backdrop and focus conventions. Initialize from `user.nickname`, trim before save, reject lengths outside 2-32 locally, disable both submission and repeated menu activation while saving, and keep the dialog open on rejection. Capture `actionMenu.active?.trigger` before closing the menu; when the dialog closes, focus that trigger if it exists. A dialog opened from a secondary click has no trigger and must not move focus.

- [ ] **Step 5: Extend the left and right member menus**

Change `RailMemberActionControl` to accept optional volume props plus `canRename` and `onRename`. Show volume only for a remote member and nickname only to the owner. In `MemberPanel`, define:

```ts
const canRename = canModerate && (user.role === "member" || user.userId === currentUser.id);
const hasActions = Boolean(
  (user.userId !== currentUser.id && voiceRoom) ||
  canRename ||
  (canModerate && user.userId !== currentUser.id)
);
```

Close the shared menu before opening the nickname dialog. Keep disconnect/kick/ban permission gates unchanged.

- [ ] **Step 6: Add owner-table editing and current nickname presentation**

Add “Change nickname” beside applicable owner table rows and reuse `NicknameDialog`. Replace active-server account/avatar labels and the local voice fallback with `props.currentNickname`; do not mutate `PublicUser.nickname`.

- [ ] **Step 7: Run web UI verification**

Run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
```

Expected: both commands PASS; existing personal-volume and owner moderation tests remain green.

---

### Task 6: Activate Voice Channels from the Channel Name

**Files:**
- Create: `apps/web/src/lib/voiceChannelActivation.ts`
- Create: `apps/web/test/voice-channel-activation.test.ts`
- Modify: `apps/web/src/App.tsx:127-160, 790-810, 1834-1965`
- Modify: `apps/web/src/lib/i18n.ts`
- Modify: `apps/web/test/voice-media-lifecycle.test.ts`
- Modify: `apps/web/test/voice-rail-live.test.ts`

**Interfaces:**
- Produces: `voiceChannelActivation(activeRoomId: string | null, targetRoomId: string): "join" | "open" | "confirm-move"`.
- Changes: `joinVoiceWithAudioUnlock(...)` and `ShellProps.onJoinVoice(...)` return `Promise<boolean>`.

- [ ] **Step 1: Write pure decision tests**

Create:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { voiceChannelActivation } from "../src/lib/voiceChannelActivation.js";

describe("voice channel activation", () => {
  it("joins from disconnected state", () => {
    assert.equal(voiceChannelActivation(null, "lobby"), "join");
  });
  it("opens the active room without rejoining", () => {
    assert.equal(voiceChannelActivation("lobby", "lobby"), "open");
  });
  it("confirms before moving rooms", () => {
    assert.equal(voiceChannelActivation("lobby", "games"), "confirm-move");
  });
});
```

- [ ] **Step 2: Run web tests and verify the module is missing**

Run: `npm run test -w @voxly/web`

Expected: FAIL because `voiceChannelActivation.ts` does not exist.

- [ ] **Step 3: Implement the pure helper**

```ts
export function voiceChannelActivation(activeRoomId: string | null, targetRoomId: string) {
  if (!activeRoomId) return "join" as const;
  if (activeRoomId === targetRoomId) return "open" as const;
  return "confirm-move" as const;
}
```

- [ ] **Step 4: Preserve the authoritative join result**

Change `joinVoiceWithAudioUnlock` to return `joined` after releasing on failure:

```ts
return join(roomId).then((joined) => {
  if (!joined) release();
  return joined;
}, (cause: unknown) => {
  release();
  throw cause;
});
```

Change `ShellProps.onJoinVoice` to `Promise<boolean>` and keep all callers awaiting or intentionally discarding the result.

- [ ] **Step 5: Orchestrate channel clicks and confirmation**

In `ChannelRail`, keep `moveTarget` and `joiningRoomId` state. A voice channel click must prevent the default navigation and:

```ts
const action = voiceChannelActivation(props.activeVoiceRoomId, room.id);
if (action === "open") {
  props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
} else if (action === "join") {
  setJoiningRoomId(room.id);
  void props.onJoinVoice(room.id).then((joined) => {
    if (joined) props.onNavigate(serverPath(props.activeServerId, "voice", room.id));
  }).finally(() => setJoiningRoomId(null));
} else {
  setMoveTarget(room);
}
```

The confirmation names the current and target rooms. Confirming uses the same join-then-navigate path; cancelling clears `moveTarget`. Ignore further voice channel activation while `joiningRoomId` is non-null.

- [ ] **Step 6: Add bilingual move confirmation copy**

Add these exact keys and values, then keep the existing direct-URL join button in `VoiceDock`:

```ts
// English
"voice.moveTitle": "Switch voice rooms?",
"voice.moveCopy": "You are in {current}. Join {target} instead?",
"voice.moveConfirm": "Switch room",

// Turkish
"voice.moveTitle": "Ses kanalı değiştirilsin mi?",
"voice.moveCopy": "Şu anda {current} kanalındasın. {target} kanalına geçmek istiyor musun?",
"voice.moveConfirm": "Kanala geç",
```

- [ ] **Step 7: Run web voice verification**

Run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
```

Expected: both commands PASS; direct join, LIVE watch, reconnect, and atomic join tests remain green.

---

### Task 7: Align Voice Sidebar and Dock Icons

**Files:**
- Modify: `apps/web/src/lib/voiceControls.ts:95-105`
- Modify: `apps/web/src/App.tsx:1865-1935, 3175-3205`
- Modify: `apps/web/src/styles.css:525-610, 2035-2060`
- Modify: `apps/web/test/voice-controls.test.ts:70-100`
- Modify: `apps/web/test/voice-rail-live.test.ts`
- Modify: `apps/web/test/screen-share-control.test.ts`

**Interfaces:**
- Changes: a deafened member returns `["muted", "deafened"]` from `sidebarVoiceStatusKeys`.
- Produces: inline microphone prefix for voice channel rows.
- Produces: screen-share SVG with effective stroke weight matching 24px dock glyphs.

- [ ] **Step 1: Change tests to the desired visual contracts**

Update the compact status expectation to:

```ts
assert.deepEqual(
  sidebarVoiceStatusKeys({ mic: false, camera: false, screen: false, deafened: true, speaking: false }),
  ["muted", "deafened"]
);
```

Require the voice channel prefix to contain `<MicIcon off={false} />` and no literal `vc`. Require `ScreenIcon` to set `strokeWidth="18"` while retaining `currentColor` through `.ui-icon`.

- [ ] **Step 2: Run web tests and verify the ordering/style failures**

Run: `npm run test -w @voxly/web`

Expected: FAIL on the old `["deafened", "muted"]` order, literal `vc`, and missing screen stroke width.

- [ ] **Step 3: Implement mute-left/deafen-right order**

Change the helper to push `muted` before `deafened`:

```ts
const statuses: SidebarVoiceStatusKey[] = [];
if (!media.mic || media.deafened) statuses.push("muted");
if (media.deafened) statuses.push("deafened");
return statuses;
```

- [ ] **Step 4: Replace `VC` with the microphone icon**

Render:

```tsx
<span className="channel-prefix" aria-hidden="true"><MicIcon off={false} /></span>
```

Keep the 18px prefix column and size the nested icon to 15px in CSS.

- [ ] **Step 5: Correct screen glyph stroke parity**

Keep the existing 256-unit monitor/upload geometry and add `strokeWidth="18"` on `ScreenIcon` so its 24px rendered stroke visually matches the other 24-unit icons. Do not hard-code white; the button's `currentColor` remains authoritative in both themes.

- [ ] **Step 6: Run web icon verification**

Run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
npm run build -w @voxly/web
```

Expected: all commands PASS.

---

### Task 8: Perform Full Regression and Visual Verification

**Files:**
- Review: all files changed in Tasks 1-7
- Preserve: `.gitignore`

**Interfaces:**
- Consumes all prior task outputs.
- Produces a verified, unstaged working-tree implementation.

- [ ] **Step 1: Run the complete automated suite**

Run:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits `0` with no TypeScript, test, build, or whitespace errors.

- [ ] **Step 2: Inspect the complete diff and working tree**

Run:

```sh
git status --short
git diff --stat
git diff -- apps/server apps/web packages/shared docs/designs docs/plans
```

Expected: `.gitignore` remains user-owned and untouched; no database, environment file, token, build artifact, or unrelated refactor appears.

- [ ] **Step 3: Check desktop voice interactions in a browser**

Start the web development server with the repository's normal local setup. Verify:

- disconnected channel click joins and then navigates;
- a different channel click confirms before moving;
- cancel and failed join retain the active room;
- mute is left of deafen;
- voice channels use a microphone prefix;
- screen share matches sibling icon weight;
- owner nickname changes propagate in left rail, right rail, voice stage, owner table, account display, and loaded messages;
- another server retains its own nickname;
- right-click and ellipsis open the same exclusive menu.

- [ ] **Step 4: Check responsive and accessible behavior**

Verify short desktop, narrow/mobile, and coarse-pointer layouts. Use keyboard navigation to open menus, change nickname, cancel a room move, close with Escape, and confirm focus restoration. Verify English and Turkish labels with a screen-reader accessibility tree or browser inspector.

- [ ] **Step 5: Report exact verification evidence**

Report every command run, its result, any browser scenarios checked, and any environment limitation. Do not claim unrun checks. Leave all files unstaged.
