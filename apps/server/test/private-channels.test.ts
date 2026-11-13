import { cookieJar, sessionToken } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { ChatMessage, RoomSummary, VoiceJoinAck, VoiceSnapshot } from "@voxly/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { openDatabase } from "../src/db/database.js";
import { roomAccess } from "../src/members.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

describe("private channels (ADR-0037)", () => {
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];
  let owner: Identity;
  let insider: Identity;
  let outsider: Identity;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "private-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "private-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    insider = await acceptInvite("Insider");
    outsider = await acceptInvite("Outsider");
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app.close();
  });

  async function acceptInvite(nickname: string): Promise<Identity> {
    const invite = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { label: nickname }
    });
    const accepted = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: invite.json().invite.token, nickname }
    });
    return { user: accepted.json().user, cookies: cookieJar(accepted) };
  }

  async function createRoom(name: string, kind: "text" | "voice") {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: owner.cookies,
      payload: { name, kind }
    });
    assert.equal(response.statusCode, 201);
    return response.json().room.id as string;
  }

  function setAccess(
    roomId: string,
    body: { isPrivate: boolean; listed: boolean; userIds: string[] },
    who: Identity = owner
  ) {
    return app.server.inject({
      method: "PUT",
      url: `/api/servers/the-basement/rooms/${roomId}/access`,
      cookies: who.cookies,
      payload: body
    });
  }

  async function roomsOf(who: Identity): Promise<RoomSummary[]> {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/servers/the-basement/rooms",
      cookies: who.cookies
    });
    return response.json().rooms;
  }

  function post(roomId: string, who: Identity, payload: Record<string, unknown> = { body: "hello" }) {
    return app.server.inject({ method: "POST", url: `/api/rooms/${roomId}/messages`, cookies: who.cookies, payload });
  }

  function history(roomId: string, who: Identity) {
    return app.server.inject({ method: "GET", url: `/api/rooms/${roomId}/messages`, cookies: who.cookies });
  }

  async function connect(who: Identity) {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createClient(baseUrl, {
        transports: ["websocket"],
        extraHeaders: { cookie: `voxly_session=${sessionToken(who.cookies)}` },
        reconnection: false
      });
      candidate.once("connect", () => resolve(candidate));
      candidate.once("connect_error", (error) => reject(error));
    });
    sockets.push(socket);
    await waitFor(() => app.io.sockets.sockets.get(socket.id!)?.rooms.has("server:the-basement") ?? false);
    return socket;
  }

  function join(socket: Socket, roomId: string) {
    return new Promise<VoiceJoinAck>((resolve) =>
      socket.emit(
        "voice:join",
        { roomId, media: { mic: true, camera: false, screen: false, deafened: false, speaking: false } },
        resolve
      )
    );
  }

  it("lets only owners change access, and refuses the AFK room, the Welcome channel and non-members", async () => {
    const secret = await createRoom("secret", "text");
    assert.equal((await setAccess(secret, { isPrivate: true, listed: false, userIds: [] }, insider)).statusCode, 403);
    assert.equal(
      (await setAccess(secret, { isPrivate: true, listed: false, userIds: ["no-such-member"] })).statusCode,
      400
    );
    const ownerListed = await setAccess(secret, { isPrivate: true, listed: false, userIds: [owner.user.id] });
    assert.equal(ownerListed.statusCode, 200);
    assert.deepEqual(ownerListed.json().room.accessUserIds, [], "owners always have access and are never listed");
    await setAccess(secret, { isPrivate: false, listed: false, userIds: [] });
    const afk = (await roomsOf(owner)).find((room) => room.isAfk)!;
    assert.equal((await setAccess(afk.id, { isPrivate: true, listed: false, userIds: [] })).statusCode, 409);

    const welcome = await app.server.inject({
      method: "PATCH",
      url: "/api/servers/the-basement/welcome",
      cookies: owner.cookies,
      payload: { welcomeNotices: true, welcomeRoomId: secret }
    });
    assert.equal(welcome.statusCode, 200);
    assert.equal((await setAccess(secret, { isPrivate: true, listed: false, userIds: [] })).statusCode, 409);

    const audited = app.sqlite
      .prepare("select count(*) as count from audit_events where action = 'room.accessChanged'")
      .get() as { count: number };
    assert.ok(audited.count >= 1, "every access change is audited");

    const other = await createRoom("other", "text");
    assert.equal((await setAccess(other, { isPrivate: true, listed: false, userIds: [] })).statusCode, 200);
    const chooseHidden = await app.server.inject({
      method: "PATCH",
      url: "/api/servers/the-basement/welcome",
      cookies: owner.cookies,
      payload: { welcomeNotices: true, welcomeRoomId: other }
    });
    assert.equal(chooseHidden.statusCode, 400);
  });

  it("creates a channel already private, and creates nothing when its access is refused", async () => {
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: owner.cookies,
      payload: {
        name: "born-private",
        kind: "text",
        access: { isPrivate: true, listed: false, userIds: [insider.user.id], roleIds: [] }
      }
    });
    assert.equal(created.statusCode, 201);
    const room = created.json().room as RoomSummary;
    assert.equal(room.isPrivate, true);
    assert.deepEqual(room.accessUserIds, [insider.user.id]);
    assert.ok((await roomsOf(insider)).some((candidate) => candidate.id === room.id));
    assert.ok(!(await roomsOf(outsider)).some((candidate) => candidate.id === room.id));

    const before = (await roomsOf(owner)).length;
    const refused = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: owner.cookies,
      payload: { name: "never", kind: "text", access: { isPrivate: true, listed: false, userIds: ["nobody"] } }
    });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "access_member_invalid");
    assert.equal((await roomsOf(owner)).length, before);
  });

  it("hides a Hidden text channel from everyone without access, history included", async () => {
    const secret = await createRoom("secret", "text");
    assert.equal((await post(secret, outsider, { body: "said while public" })).statusCode, 201);
    const update = await setAccess(secret, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    assert.equal(update.statusCode, 200);
    assert.deepEqual(update.json().room.accessUserIds, [insider.user.id]);

    assert.equal(
      (await roomsOf(outsider)).some((room) => room.id === secret),
      false
    );
    assert.equal((await history(secret, outsider)).statusCode, 404, "even their own past message is gone");
    assert.equal((await post(secret, outsider)).statusCode, 404);

    const seen = (await roomsOf(insider)).find((room) => room.id === secret)!;
    assert.equal(seen.isPrivate, true);
    assert.equal(seen.canEnter, true);
    assert.deepEqual(seen.accessUserIds, [insider.user.id]);
    assert.equal((await post(secret, insider)).statusCode, 201);
    const ownerView = (await roomsOf(owner)).find((room) => room.id === secret)!;
    assert.equal(ownerView.canEnter, true);

    const notifications = await app.server.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: outsider.cookies
    });
    const roomIds = notifications
      .json()
      .servers.flatMap((server: { rooms: Array<{ roomId: string }> }) => server.rooms.map((room) => room.roomId));
    assert.equal(roomIds.includes(secret), false);
  });

  it("lets everyone read a Listed text channel but only those with access write in it", async () => {
    const news = await createRoom("news", "text");
    await setAccess(news, { isPrivate: true, listed: true, userIds: [insider.user.id] });
    const seen = (await roomsOf(outsider)).find((room) => room.id === news)!;
    assert.equal(seen.listed, true);
    assert.equal(seen.canEnter, false);
    assert.equal(seen.accessUserIds, undefined, "the list itself is private");
    assert.equal((await post(news, insider)).statusCode, 201);
    assert.equal((await history(news, outsider)).statusCode, 200);
    assert.equal((await post(news, outsider)).statusCode, 403);
  });

  it("keeps Mentions inside the channel's access", async () => {
    const secret = await createRoom("secret", "text");
    await setAccess(secret, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    const everyone = await post(secret, insider, {
      body: "@everyone hi",
      mentions: [{ kind: "everyone", start: 0, end: 9 }]
    });
    assert.equal(everyone.statusCode, 201);
    const recipients = (everyone.json().message as ChatMessage).mentions[0]!.recipientIds;
    assert.deepEqual(new Set(recipients), new Set([owner.user.id, insider.user.id]));
    const person = await post(secret, insider, {
      body: "@Outsider hi",
      mentions: [{ kind: "person", userId: outsider.user.id, start: 0, end: 9 }]
    });
    assert.equal(person.statusCode, 400);
  });

  it("drops a kicked member's access so rejoining does not restore it", async () => {
    const secret = await createRoom("secret", "text");
    await setAccess(secret, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    const kicked = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/members/${insider.user.id}/kick`,
      cookies: owner.cookies
    });
    assert.equal(kicked.statusCode, 204);
    assert.equal(app.sqlite.prepare("select count(*) as count from room_access").get()?.count, 0);
  });

  it("delivers a Hidden channel's new messages only to those who may read it", async () => {
    const secret = await createRoom("secret", "text");
    await setAccess(secret, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    const insiderSocket = await connect(insider);
    const outsiderSocket = await connect(outsider);
    const arrives = once<ChatMessage>(insiderSocket, "message:new");
    const silent = expectNone(outsiderSocket, "message:new");
    assert.equal((await post(secret, owner)).statusCode, 201);
    assert.equal((await arrives).roomId, secret);
    await silent;
  });

  it("refuses voice joins and moves without access, and hides a Hidden voice channel's roster", async () => {
    const den = await createRoom("den", "voice");
    await setAccess(den, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    const insiderSocket = await connect(insider);
    const outsiderSocket = await connect(outsider);

    assert.deepEqual(await join(outsiderSocket, den), { ok: false, error: "room_not_found" });
    const silent = expectNone(outsiderSocket, "voice:joined");
    assert.equal((await join(insiderSocket, den)).ok, true);
    await silent;
    const peek = await new Promise<VoiceSnapshot>((resolve) => outsiderSocket.emit("voice:snapshot", den, resolve));
    assert.deepEqual(peek.members, []);

    assert.equal((await join(outsiderSocket, "lobby")).ok, true);
    const move = await app.server.inject({
      method: "POST",
      url: `/api/servers/the-basement/voice/members/${outsider.user.id}/move`,
      cookies: owner.cookies,
      payload: { roomId: den }
    });
    assert.equal(move.statusCode, 409);
  });

  it("shows a Listed voice channel's members to everyone but its Call length only to entrants", async () => {
    const stage = await createRoom("stage", "voice");
    await setAccess(stage, { isPrivate: true, listed: true, userIds: [insider.user.id] });
    const ownerSocket = await connect(owner);
    const insiderSocket = await connect(insider);
    const outsiderSocket = await connect(outsider);

    assert.deepEqual(await join(outsiderSocket, stage), { ok: false, error: "forbidden" });
    const observed = nextSnapshot(
      outsiderSocket,
      (snapshot) => snapshot.roomId === stage && snapshot.members.length > 0
    );
    const entrant = nextSnapshot(ownerSocket, (snapshot) => snapshot.roomId === stage && snapshot.members.length > 0);
    assert.equal((await join(insiderSocket, stage)).ok, true);
    const outside = await observed;
    assert.equal(outside.members[0]!.user.userId, insider.user.id);
    assert.equal(outside.callLengthMs, undefined);
    assert.equal(typeof (await entrant).callLengthMs, "number");
  });

  it("forces a member out of voice the moment they lose access", async () => {
    const den = await createRoom("den", "voice");
    await setAccess(den, { isPrivate: true, listed: false, userIds: [insider.user.id] });
    const insiderSocket = await connect(insider);
    assert.equal((await join(insiderSocket, den)).ok, true);
    const forced = once<{ roomId: string; reason: string }>(insiderSocket, "voice:forceLeave");
    assert.equal((await setAccess(den, { isPrivate: true, listed: false, userIds: [] })).statusCode, 200);
    assert.deepEqual(await forced, { roomId: den, reason: "room_access_revoked" });
  });
});

describe("the Music bot in a private channel (ADR-0037)", () => {
  const botToken = "private-channel-bot-token-long-enough";
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "private-bot-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false,
      bot: { token: botToken }
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app.close();
  });

  async function connectWith(token: string) {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createClient(baseUrl, {
        transports: ["websocket"],
        extraHeaders: { cookie: `voxly_session=${token}` },
        reconnection: false
      });
      candidate.once("connect", () => resolve(candidate));
      candidate.once("connect_error", (error) => reject(error));
    });
    sockets.push(socket);
    return socket;
  }

  function join(socket: Socket, roomId: string) {
    return new Promise<VoiceJoinAck>((resolve) =>
      socket.emit(
        "voice:join",
        { roomId, media: { mic: false, camera: false, screen: false, deafened: false, speaking: false } },
        resolve
      )
    );
  }

  it("lets the bot in only after someone with access summons it there", async () => {
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "private-bot-fixture", nickname: "Owner" }
    });
    const ownerCookies = cookieJar(bootstrap);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: ownerCookies,
      payload: { name: "den", kind: "voice" }
    });
    const den = created.json().room.id as string;
    const access = await app.server.inject({
      method: "PUT",
      url: `/api/servers/the-basement/rooms/${den}/access`,
      cookies: ownerCookies,
      payload: { isPrivate: true, listed: false, userIds: [] }
    });
    assert.equal(access.statusCode, 200);

    const exchange = await app.server.inject({
      method: "POST",
      url: "/api/bot/sessions",
      headers: { authorization: `Bearer ${botToken}` }
    });
    const [botSession] = exchange.json().sessions as Array<{ token: string }>;
    const botSocket = await connectWith(botSession!.token);
    botSocket.on("music:command", (_payload: unknown, ack: (response: unknown) => void) =>
      ack({ ok: true, kind: "track", track: null })
    );

    assert.equal((await join(botSocket, den)).ok, false, "the bot is never on a Channel access list");

    const ownerSocket = await connectWith(sessionToken(ownerCookies));
    assert.equal((await join(ownerSocket, den)).ok, true);
    await new Promise((resolve) =>
      ownerSocket.emit(
        "music:control",
        { roomId: den, command: { kind: "add", input: "https://www.youtube.com/watch?v=aB3dE5gH7jK" } },
        resolve
      )
    );
    assert.equal((await join(botSocket, den)).ok, true, "a Summon by an owner lets it in");

    // A command for another channel must not cost the bot its place here: the
    // allowance belongs to the Set, not to whichever channel spoke last.
    const insider = await (async () => {
      const invite = await app.server.inject({
        method: "POST",
        url: "/api/owner/invites",
        cookies: ownerCookies,
        payload: { label: "Lobby member" }
      });
      const accepted = await app.server.inject({
        method: "POST",
        url: "/api/invites/accept",
        payload: { inviteToken: invite.json().invite.token, nickname: "Lobby member" }
      });
      return connectWith(sessionToken(cookieJar(accepted)));
    })();
    assert.equal((await join(insider, "lobby")).ok, true);
    await new Promise((resolve) =>
      insider.emit(
        "music:control",
        { roomId: "lobby", command: { kind: "add", input: "https://www.youtube.com/watch?v=aB3dE5gH7jK" } },
        resolve
      )
    );
    assert.equal((await join(botSocket, den)).ok, true, "still allowed after another channel's command");

    botSocket.emit("voice:leave", den);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await join(botSocket, den)).ok, false, "leaving on purpose ends the allowance");
  });
});

describe("the access rule itself (ADR-0037)", () => {
  it("grants owners and the list everything, Listed outsiders reading only, Hidden outsiders nothing", async () => {
    const db = await openDatabase(":memory:");
    try {
      const sqlite = db.sqlite;
      const now = new Date().toISOString();
      for (const [id, role] of [
        ["owner", "owner"],
        ["insider", "member"],
        ["outsider", "member"]
      ] as const) {
        sqlite.prepare("insert into users (id, nickname, role) values (?, ?, 'member')").run(id, id);
        sqlite
          .prepare("insert into server_members (server_id, user_id, role, joined_at) values ('the-basement', ?, ?, ?)")
          .run(id, role, now);
      }
      sqlite
        .prepare("insert into room_access (room_id, user_id, granted_at) values ('general', 'insider', ?)")
        .run(now);
      const hidden = { id: "general", serverId: "the-basement", isPrivate: true, listed: false };
      const everything = { canSee: true, canRead: true, canEnter: true };
      const nothing = { canSee: false, canRead: false, canEnter: false };
      assert.deepEqual(roomAccess(sqlite, hidden, "owner"), everything);
      assert.deepEqual(roomAccess(sqlite, hidden, "insider"), everything);
      assert.deepEqual(roomAccess(sqlite, hidden, "outsider"), nothing);
      assert.deepEqual(roomAccess(sqlite, { ...hidden, listed: true }, "outsider"), {
        canSee: true,
        canRead: true,
        canEnter: false
      });
      assert.deepEqual(roomAccess(sqlite, { ...hidden, isPrivate: false }, "outsider"), everything);
      assert.deepEqual(roomAccess(sqlite, hidden, "stranger"), nothing);
    } finally {
      db.close();
    }
  });

  it("upgrades a database from before private channels with every channel still public", async () => {
    const directory = await mkdtemp(joinPath(tmpdir(), "voxly-private-"));
    const path = joinPath(directory, "legacy.sqlite");
    try {
      const first = await openDatabase(path);
      first.sqlite.exec(
        "drop table room_access; alter table rooms drop column is_private; alter table rooms drop column listed;"
      );
      first.close();
      const upgraded = await openDatabase(path);
      try {
        const columns = upgraded.sqlite.prepare("select name from pragma_table_info('rooms')").all() as Array<{
          name: string;
        }>;
        assert.ok(columns.some((column) => column.name === "is_private"));
        assert.ok(columns.some((column) => column.name === "listed"));
        const privateCount = upgraded.sqlite
          .prepare("select count(*) as count from rooms where is_private != 0")
          .get() as { count: number };
        assert.equal(privateCount.count, 0);
        assert.equal(
          (upgraded.sqlite.prepare("select count(*) as count from room_access").get() as { count: number }).count,
          0
        );
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition never held");
}

function once<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1000);
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

function expectNone(socket: Socket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${event}`));
    };
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, 250);
    socket.once(event, onEvent);
  });
}

function nextSnapshot(socket: Socket, matches: (snapshot: VoiceSnapshot) => boolean): Promise<VoiceSnapshot> {
  return new Promise((resolve, reject) => {
    const onSnapshot = (snapshot: VoiceSnapshot) => {
      if (!matches(snapshot)) return;
      clearTimeout(timeout);
      socket.off("voice:snapshot", onSnapshot);
      resolve(snapshot);
    };
    const timeout = setTimeout(() => {
      socket.off("voice:snapshot", onSnapshot);
      reject(new Error("Timed out waiting for voice:snapshot"));
    }, 1000);
    socket.on("voice:snapshot", onSnapshot);
  });
}
