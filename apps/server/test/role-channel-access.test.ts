import { cookieJar, sessionToken } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { Permission, RoomSummary, VoiceJoinAck } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { all, defaultServerId, one } from "../src/db/database.js";
import { roomAccess, roomEntrantIds } from "../src/members.js";
import { roomById } from "../src/rooms.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

/** Roles on Channel access, and Administrator in every Private channel (ADR-0038, decision 21). */
describe("Roles on Channel access", () => {
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];
  let owner: Identity;
  let member: Identity;
  let outsider: Identity;
  const server = `/api/servers/${defaultServerId}`;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "role-access-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "role-access-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    member = await acceptInvite("Member");
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

  async function createRole(permissions: Permission[] = []) {
    const created = await app.server.inject({
      method: "POST",
      url: `${server}/roles`,
      cookies: owner.cookies,
      payload: { name: `Role ${Math.random().toString(36).slice(2, 8)}` }
    });
    const roleId = created.json().role.id as string;
    if (permissions.length > 0) await setPermissions(roleId, permissions);
    return roleId;
  }

  function setPermissions(roleId: string, permissions: Permission[]) {
    return app.server.inject({
      method: "PATCH",
      url: `${server}/roles/${roleId}`,
      cookies: owner.cookies,
      payload: { permissions }
    });
  }

  function setRole(who: Identity, roleId: string, give: boolean) {
    return app.server.inject({
      method: give ? "PUT" : "DELETE",
      url: `${server}/members/${who.user.id}/roles/${roleId}`,
      cookies: owner.cookies
    });
  }

  async function createRoom(name: string, kind: "text" | "voice") {
    const response = await app.server.inject({
      method: "POST",
      url: `${server}/rooms`,
      cookies: owner.cookies,
      payload: { name, kind }
    });
    return response.json().room.id as string;
  }

  function setAccess(roomId: string, body: { userIds?: string[]; roleIds?: string[]; listed?: boolean }) {
    return app.server.inject({
      method: "PUT",
      url: `${server}/rooms/${roomId}/access`,
      cookies: owner.cookies,
      payload: {
        isPrivate: true,
        listed: body.listed ?? false,
        userIds: body.userIds ?? [],
        roleIds: body.roleIds ?? []
      }
    });
  }

  async function roomsOf(who: Identity) {
    const response = await app.server.inject({ method: "GET", url: `${server}/rooms`, cookies: who.cookies });
    return response.json().rooms as RoomSummary[];
  }

  function history(roomId: string, who: Identity) {
    return app.server.inject({ method: "GET", url: `/api/rooms/${roomId}/messages`, cookies: who.cookies });
  }

  function post(roomId: string, who: Identity) {
    return app.server.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      cookies: who.cookies,
      payload: { body: "hello" }
    });
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
    await waitFor(() => app.io.sockets.sockets.get(socket.id!)?.rooms.has(`server:${defaultServerId}`) ?? false);
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

  /** Whether `who` reads, writes and sees the channel, as one fact. */
  async function enters(roomId: string, who: Identity) {
    const listed = (await roomsOf(who)).find((room) => room.id === roomId);
    const read = (await history(roomId, who)).statusCode === 200;
    const write = (await post(roomId, who)).statusCode === 201;
    assert.equal(read, write, "reading and writing go together for a Hidden channel");
    assert.equal(Boolean(listed?.canEnter), read, "the channel list agrees with the history");
    return read;
  }

  it("lets in a member admitted only through a Role, and refuses everyone else", async () => {
    const role = await createRole();
    await setRole(member, role, true);
    const den = await createRoom("den", "text");
    const update = await setAccess(den, { roleIds: [role] });
    assert.equal(update.statusCode, 200);
    assert.deepEqual(update.json().room.accessRoleIds, [role]);
    assert.equal(await enters(den, member), true);
    assert.equal(await enters(den, outsider), false);
    // The Role on the access list is shown to those who can enter, under the same rule as people.
    assert.deepEqual((await roomsOf(member)).find((room) => room.id === den)?.accessRoleIds, [role]);

    const posted = await post(den, owner);
    const messageId = posted.json().message.id as string;
    const reaction = await app.server.inject({
      method: "PUT",
      url: `/api/rooms/${den}/messages/${messageId}/reactions/👍`,
      cookies: member.cookies
    });
    assert.equal(reaction.statusCode, 200);
  });

  it("revokes at once when the Role leaves the member, leaves the channel, or is deleted", async () => {
    const den = await createRoom("den", "text");
    for (const revoke of ["member", "channel", "deleted"] as const) {
      const role = await createRole();
      await setRole(member, role, true);
      await setAccess(den, { roleIds: [role] });
      assert.equal(await enters(den, member), true, revoke);
      if (revoke === "member") await setRole(member, role, false);
      if (revoke === "channel") await setAccess(den, { roleIds: [] });
      if (revoke === "deleted") {
        const deleted = await app.server.inject({
          method: "DELETE",
          url: `${server}/roles/${role}`,
          cookies: owner.cookies
        });
        assert.equal(deleted.statusCode, 204);
        assert.equal(
          one<{ count: number }>(app.sqlite, "select count(*) as count from room_access_roles where role_id = ?", [
            role
          ])?.count,
          0
        );
      }
      assert.equal(await enters(den, member), false, revoke);
    }
  });

  it("lets an Administrator holder into every Private channel, and switching it off revokes", async () => {
    const den = await createRoom("den", "text");
    await setAccess(den, {});
    const role = await createRole(["administrator"]);
    await setRole(member, role, true);
    assert.equal(await enters(den, member), true);
    assert.equal((await setPermissions(role, [])).statusCode, 200);
    assert.equal(await enters(den, member), false);
  });

  it("forces a member out of voice when their only way in, a Role, goes", async () => {
    const stage = await createRoom("stage", "voice");
    const role = await createRole();
    await setRole(member, role, true);
    await setAccess(stage, { roleIds: [role] });
    const memberSocket = await connect(member);
    const outsiderSocket = await connect(outsider);
    assert.deepEqual(await join(outsiderSocket, stage), { ok: false, error: "room_not_found" });
    assert.equal((await join(memberSocket, stage)).ok, true);

    const forced = once<{ roomId: string; reason: string }>(memberSocket, "voice:forceLeave");
    const roomsChanged = once<{ serverId: string }>(outsiderSocket, "server:roomsChanged");
    assert.equal((await setRole(member, role, false)).statusCode, 200);
    assert.deepEqual(await forced, { roomId: stage, reason: "room_access_revoked" });
    assert.deepEqual(await roomsChanged, { serverId: defaultServerId });
  });

  it("forces an Administrator out of voice when Administrator is switched off, @everyone's included", async () => {
    const stage = await createRoom("stage", "voice");
    await setAccess(stage, {});
    const everyone = one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and kind = 'everyone'", [
      defaultServerId
    ])!.id;
    assert.equal((await setPermissions(everyone, ["administrator"])).statusCode, 200);
    const memberSocket = await connect(member);
    assert.equal((await join(memberSocket, stage)).ok, true);
    const forced = once<{ roomId: string; reason: string }>(memberSocket, "voice:forceLeave");
    assert.equal((await setPermissions(everyone, [])).statusCode, 200);
    assert.deepEqual(await forced, { roomId: stage, reason: "room_access_revoked" });
  });

  it("leaves a Listed channel readable but not writable once the Role goes, and keeps Role entries a caller left out", async () => {
    const den = await createRoom("den", "text");
    const role = await createRole();
    await setRole(member, role, true);
    await setAccess(den, { roleIds: [role], listed: true });
    assert.equal((await post(den, member)).statusCode, 201);
    // A request that names only people keeps the Role entry.
    const peopleOnly = await app.server.inject({
      method: "PUT",
      url: `${server}/rooms/${den}/access`,
      cookies: owner.cookies,
      payload: { isPrivate: true, listed: true, userIds: [] }
    });
    assert.deepEqual(peopleOnly.json().room.accessRoleIds, [role]);
    await setRole(member, role, false);
    assert.equal((await history(den, member)).statusCode, 200);
    assert.equal((await post(den, member)).statusCode, 403);
    assert.equal((await roomsOf(member)).find((room) => room.id === den)?.canEnter, false);
  });

  it("sends a new message to a member let in by a Role, and mentions reach them", async () => {
    const den = await createRoom("den", "text");
    const role = await createRole();
    await setRole(member, role, true);
    await setAccess(den, { roleIds: [role] });
    const memberSocket = await connect(member);
    memberSocket.emit("room:join", den);
    await waitFor(() => app.io.sockets.sockets.get(memberSocket.id!)?.rooms.has(`room:${den}`) ?? false);
    const arrived = once<{ roomId: string }>(memberSocket, "message:new");
    assert.equal((await post(den, owner)).statusCode, 201);
    assert.equal((await arrived).roomId, den);
  });

  it("names exactly the members roomAccess lets in, whichever way they got there", async () => {
    const den = await createRoom("den", "text");
    const crew = await createRole();
    const admins = await createRole(["administrator"]);
    const viaRole = await acceptInvite("ViaRole");
    const viaAdmin = await acceptInvite("ViaAdmin");
    const direct = await acceptInvite("Direct");
    await setRole(viaRole, crew, true);
    await setRole(viaAdmin, admins, true);
    await setAccess(den, { userIds: [direct.user.id], roleIds: [crew] });
    const check = () => {
      const room = roomById(app.sqlite, den)!;
      const everyone = all<{ user_id: string }>(app.sqlite, "select user_id from server_members where server_id = ?", [
        defaultServerId
      ]).map((row) => row.user_id);
      const expected = everyone.filter((userId) => roomAccess(app.sqlite, room, userId).canEnter).sort();
      assert.deepEqual([...roomEntrantIds(app.sqlite, room)].sort(), expected);
      return expected;
    };
    const entrants = check();
    for (const who of [owner, viaRole, viaAdmin, direct]) assert.ok(entrants.includes(who.user.id));
    assert.equal(entrants.includes(outsider.user.id), false);
    // With Administrator on @everyone, everyone but the Bot is in.
    const everyoneRole = one<{ id: string }>(
      app.sqlite,
      "select id from roles where server_id = ? and kind = 'everyone'",
      [defaultServerId]
    )!.id;
    await setPermissions(everyoneRole, ["administrator"]);
    assert.ok(check().includes(outsider.user.id));
  });

  it("refuses @everyone, an unknown Role and another Server's Role on Channel access", async () => {
    const den = await createRoom("den", "text");
    const everyone = one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and kind = 'everyone'", [
      defaultServerId
    ])!.id;
    assert.equal((await setAccess(den, { roleIds: [everyone] })).statusCode, 400);
    assert.equal((await setAccess(den, { roleIds: [crypto.randomUUID()] })).statusCode, 400);
    const other = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Other" }
    });
    const foreign = one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and kind = 'admin'", [
      other.json().server.id
    ])!.id;
    assert.equal((await setAccess(den, { roleIds: [foreign] })).statusCode, 400);
  });

  it("starts a member let in by a Role with the channel read, so its history is not unread", async () => {
    const den = await createRoom("den", "text");
    await setAccess(den, {});
    await post(den, owner);
    const role = await createRole();
    await setAccess(den, { roleIds: [role] });
    await setRole(member, role, true);
    const notifications = await app.server.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: member.cookies
    });
    const rooms = notifications
      .json()
      .servers.flatMap((entry: { rooms: Array<{ roomId: string; unreadCount: number }> }) => entry.rooms);
    const entry = rooms.find((room: { roomId: string }) => room.roomId === den);
    assert.ok(entry, "the channel is now in their notification state");
    assert.equal(entry.unreadCount, 0);
  });
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
