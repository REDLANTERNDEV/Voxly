import assert from "node:assert/strict";
import { it } from "node:test";
import { createVoxlyApp } from "../src/app.js";

it("renames text, voice, and AFK channels in place with owner-only server scope", async () => {
  const app = await createVoxlyApp({ databasePath: ":memory:", ownerBootstrapToken: "rename-fixture", allowHttpOwnerBootstrap: true, secureCookies: false });
  try {
    const bootstrap = await app.server.inject({ method: "POST", url: "/api/bootstrap/owner", payload: { bootstrapToken: "rename-fixture", nickname: "Owner" } });
    const cookies = Object.fromEntries(bootstrap.cookies.map((cookie) => [cookie.name, cookie.value]));
    const list = await app.server.inject({ method: "GET", url: "/api/servers/the-basement/rooms", cookies });
    for (const room of list.json().rooms) {
      const name = `Renamed ${room.name}`;
      const response = await app.server.inject({ method: "PATCH", url: `/api/servers/the-basement/rooms/${room.id}`, cookies, payload: { name: ` ${name} ` } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().room, { ...room, name });
      assert.equal(app.sqlite.prepare("select name from rooms where id = ?").get(room.id)?.name, name);
    }
    for (const name of [" ", "x", "x".repeat(65)]) {
      assert.equal((await app.server.inject({ method: "PATCH", url: "/api/servers/the-basement/rooms/general", cookies, payload: { name } })).statusCode, 400);
    }
    const another = await app.server.inject({ method: "POST", url: "/api/servers", cookies, payload: { name: "Elsewhere" } });
    const serverId = another.json().server.id;
    assert.equal((await app.server.inject({ method: "PATCH", url: `/api/servers/${serverId}/rooms/general`, cookies, payload: { name: "Wrong scope" } })).statusCode, 404);
    const invite = await app.server.inject({ method: "POST", url: "/api/owner/invites", cookies, payload: { label: "Member" } });
    const accepted = await app.server.inject({ method: "POST", url: "/api/invites/accept", payload: { inviteToken: invite.json().invite.token, nickname: "Member" } });
    const memberCookies = Object.fromEntries(accepted.cookies.map((cookie) => [cookie.name, cookie.value]));
    assert.equal((await app.server.inject({ method: "PATCH", url: "/api/servers/the-basement/rooms/general", cookies: memberCookies, payload: { name: "Forbidden" } })).statusCode, 403);
    assert.equal((await app.server.inject({ method: "PATCH", url: "/api/servers/the-basement/rooms/general", payload: { name: "Forbidden" } })).statusCode, 401);
  } finally { await app.close(); }
});
