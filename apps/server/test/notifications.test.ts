import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { notificationState } from "../src/notifications.js";
import { activateServerMembership } from "../src/members.js";

describe("persistent personal notifications", () => {
  let app: VoxlyApp, directory: string, path: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "voxly-notifications-"));
    path = join(directory, "database.sqlite");
    app = await createVoxlyApp({
      databasePath: path,
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
  });
  afterEach(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const jar = (response: { cookies: Array<{ name: string; value: string }> }) =>
    Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
  async function owner() {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
    });
    assert.equal(response.statusCode, 201);
    return { cookies: jar(response), id: response.json().user.id as string };
  }
  async function member(cookies: Record<string, string>) {
    const invite = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies,
      payload: { label: "Notifications" }
    });
    const response = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: invite.json().invite.token, nickname: "Member" }
    });
    assert.equal(response.statusCode, 201);
    return { cookies: jar(response), id: response.json().user.id as string };
  }
  async function post(cookies: Record<string, string>, room = "general") {
    const response = await app.server.inject({
      method: "POST",
      url: `/api/rooms/${room}/messages`,
      cookies,
      payload: { body: "A new message" }
    });
    assert.equal(response.statusCode, 201);
    return response.json().message;
  }
  async function state(cookies: Record<string, string>) {
    const response = await app.server.inject({ method: "GET", url: "/api/notifications", cookies });
    assert.equal(response.statusCode, 200);
    return response.json().servers.find((server: { serverId: string }) => server.serverId === "the-basement");
  }
  it("starts clean on joining, counts offline arrivals once, excludes self and deleted messages", async () => {
    const o = await owner();
    await post(o.cookies);
    const m = await member(o.cookies);
    assert.equal((await state(m.cookies)).rooms[0].unreadCount, 0);
    const message = await post(o.cookies);
    await post(m.cookies);
    assert.equal((await state(m.cookies)).rooms[0].unreadCount, 1);
    assert.equal((await state(m.cookies)).rooms[0].unreadCount, 1);
    await app.server.inject({ method: "DELETE", url: `/api/rooms/general/messages/${message.id}`, cookies: o.cookies });
    assert.equal((await state(m.cookies)).rooms[0].unreadCount, 0);
  });
  it("keeps newer arrivals unread when a read races a message and never rolls a cursor back", async () => {
    const o = await owner(),
      m = await member(o.cookies);
    const first = await post(o.cookies);
    const history = await app.server.inject({ method: "GET", url: "/api/rooms/general/messages", cookies: m.cookies });
    assert.equal(history.json().readThroughSequence, first.sequence);
    const second = await post(o.cookies);
    const read = (throughSequence: number) =>
      app.server.inject({
        method: "PUT",
        url: "/api/rooms/general/read-state",
        cookies: m.cookies,
        payload: { throughSequence }
      });
    assert.equal((await read(first.sequence)).statusCode, 200);
    assert.equal((await state(m.cookies)).rooms[0].unreadCount, 1);
    await read(second.sequence);
    await read(first.sequence);
    assert.equal((await state(m.cookies)).rooms[0].lastReadSequence, second.sequence);
    assert.equal((await read(second.sequence + 1)).statusCode, 400);
  });
  it("supports every mute preset without discarding backlog and expires using server time", async () => {
    const o = await owner(),
      m = await member(o.cookies);
    await post(o.cookies);
    for (const durationMinutes of [15, 60, 180, 480, 1440]) {
      const response = await app.server.inject({
        method: "PATCH",
        url: "/api/servers/the-basement/notification-settings",
        cookies: m.cookies,
        payload: { mode: "timed", durationMinutes }
      });
      assert.equal(response.statusCode, 200);
      const server = response.json().servers[0];
      assert.equal(server.mute.mode, "until");
      const remaining = Date.parse(server.mute.until) - Date.parse(response.json().serverTime);
      assert.ok(remaining <= durationMinutes * 60_000 && remaining > durationMinutes * 60_000 - 1_000);
      assert.equal(server.rooms[0].unreadCount, 1);
      const expired = notificationState(
        { sqlite: app.sqlite, save() {}, close() {} },
        m.id,
        Date.parse(server.mute.until)
      );
      assert.equal(expired.servers[0].mute.mode, "enabled");
    }
    for (const mode of ["indefinite", "enabled"]) {
      const response = await app.server.inject({
        method: "PATCH",
        url: "/api/servers/the-basement/notification-settings",
        cookies: m.cookies,
        payload: { mode }
      });
      assert.equal(response.json().servers[0].mute.mode, mode);
      assert.equal(response.json().servers[0].rooms[0].unreadCount, 1);
    }
    assert.equal(
      (
        await app.server.inject({
          method: "PATCH",
          url: "/api/servers/the-basement/notification-settings",
          cookies: m.cookies,
          payload: { mode: "timed", durationMinutes: 17 }
        })
      ).statusCode,
      400
    );
  });
  it("persists read cursors and indefinite mute across restart", async () => {
    const o = await owner(),
      m = await member(o.cookies);
    const first = await post(o.cookies);
    await app.server.inject({
      method: "PUT",
      url: "/api/rooms/general/read-state",
      cookies: m.cookies,
      payload: { throughSequence: first.sequence }
    });
    await app.server.inject({
      method: "PATCH",
      url: "/api/servers/the-basement/notification-settings",
      cookies: m.cookies,
      payload: { mode: "indefinite" }
    });
    const second = await post(o.cookies);
    await app.close();
    app = await createVoxlyApp({ databasePath: path, secureCookies: false });
    const server = await state(m.cookies);
    assert.equal(server.mute.mode, "indefinite");
    assert.equal(server.rooms[0].unreadCount, 1);
    assert.equal(server.rooms[0].lastReadSequence, first.sequence);
    assert.equal(server.rooms[0].latestSequence, second.sequence);
  });
  it("keeps channels independent and refuses outsiders or revoked memberships", async () => {
    const o = await owner(),
      m = await member(o.cookies);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers/the-basement/rooms",
      cookies: o.cookies,
      payload: { name: "Other", kind: "text" }
    });
    assert.equal(created.statusCode, 201);
    const roomId = created.json().room.id;
    const first = await post(o.cookies);
    await post(o.cookies, roomId);
    await app.server.inject({
      method: "PUT",
      url: "/api/rooms/general/read-state",
      cookies: m.cookies,
      payload: { throughSequence: first.sequence }
    });
    const counts = (await state(m.cookies)).rooms;
    assert.equal(counts.find((room: { roomId: string }) => room.roomId === "general").unreadCount, 0);
    assert.equal(counts.find((room: { roomId: string }) => room.roomId === roomId).unreadCount, 1);
    const elsewhere = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: o.cookies,
      payload: { name: "Private" }
    });
    assert.equal(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/servers/${elsewhere.json().server.id}/notification-settings`,
          cookies: m.cookies,
          payload: { mode: "indefinite" }
        })
      ).statusCode,
      403
    );
    app.sqlite
      .prepare("update server_members set removed_at = ? where user_id = ?")
      .run(new Date().toISOString(), m.id);
    assert.equal(
      (
        await app.server.inject({
          method: "PUT",
          url: "/api/rooms/general/read-state",
          cookies: m.cookies,
          payload: { throughSequence: 0 }
        })
      ).statusCode,
      403
    );
    activateServerMembership(
      { sqlite: app.sqlite, save() {}, close() {} },
      "the-basement",
      m.id,
      "member",
      new Date().toISOString()
    );
    assert.ok((await state(m.cookies)).rooms.every((room: { unreadCount: number }) => room.unreadCount === 0));
  });
  it("backfills legacy history only once and retains sequence ordering", async () => {
    await app.close();
    const legacyPath = join(directory, "legacy.sqlite"),
      legacy = new DatabaseSync(legacyPath);
    legacy.exec(`create table users(id text primary key, nickname text not null, role text not null, banned_at text);
      insert into users values('old', 'Legacy', 'member', null);
      create table rooms(id text primary key, name text not null, kind text not null, position integer not null);
      insert into rooms values('general', 'general', 'text', 10);
      create table messages(id text primary key, room_id text not null, user_id text not null, body text not null, created_at text not null);
      insert into messages values('first', 'general', 'old', 'Old', '2026-01-01');
      insert into messages values('second', 'general', 'old', 'Old again', '2026-01-01');`);
    legacy.close();
    app = await createVoxlyApp({ databasePath: legacyPath, secureCookies: false });
    const sequences = app.sqlite.prepare("select sequence from messages order by sequence").all();
    assert.deepEqual(
      sequences.map((row) => row.sequence),
      [1, 2]
    );
    assert.equal(
      app.sqlite.prepare("select last_read_sequence from room_read_cursors where user_id = 'old'").get()
        ?.last_read_sequence,
      2
    );
    app.sqlite.prepare("update room_read_cursors set last_read_sequence = 1 where user_id = 'old'").run();
    await app.close();
    app = await createVoxlyApp({ databasePath: legacyPath, secureCookies: false });
    assert.equal(
      app.sqlite.prepare("select last_read_sequence from room_read_cursors where user_id = 'old'").get()
        ?.last_read_sequence,
      1
    );
  });
});
