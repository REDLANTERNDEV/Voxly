import { cookieJar } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { defaultServerId, one } from "../src/db/database.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

/** Server settings run on Manage server, not ownership (ADR-0038, design decision 15). */
describe("Server settings on Permissions", () => {
  let app: VoxlyApp;
  let owner: Identity;
  let admin: Identity;
  let recruiter: Identity;
  let plain: Identity;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "settings-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "settings-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    admin = await acceptInvite("Admin");
    recruiter = await acceptInvite("Recruiter");
    plain = await acceptInvite("Plain");
    await give(admin, "admin");
    await give(recruiter, "recruiter");
  });

  afterEach(async () => {
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

  async function give(who: Identity, seed: "admin" | "recruiter") {
    const role = one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and seed = ?", [
      defaultServerId,
      seed
    ])!;
    const response = await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${who.user.id}/roles/${role.id}`,
      cookies: owner.cookies
    });
    assert.equal(response.statusCode, 200);
  }

  const routes = [
    { method: "PATCH" as const, url: `/api/servers/${defaultServerId}`, payload: { name: "Onyx Lounge" } },
    { method: "PATCH" as const, url: `/api/servers/${defaultServerId}/afk`, payload: { afkTimeoutMinutes: 30 } },
    {
      method: "PATCH" as const,
      url: `/api/servers/${defaultServerId}/welcome`,
      payload: { welcomeNotices: false, welcomeRoomId: null }
    }
  ];

  it("lets an Admin rename the Server and change AFK and the welcome notice", async () => {
    for (const route of routes) {
      const response = await app.server.inject({ ...route, cookies: admin.cookies });
      assert.equal(response.statusCode, 200, route.url);
    }
    const renamed = await app.server.inject({ ...routes[0]!, cookies: admin.cookies });
    // The answer describes the caller, who is a member holding Admin.
    assert.equal(renamed.json().server.role, "member");
    assert.equal(renamed.json().server.name, "Onyx Lounge");
  });

  it("refuses a plain member and a Davetçi member every one of them", async () => {
    for (const who of [plain, recruiter]) {
      for (const route of routes) {
        const response = await app.server.inject({ ...route, cookies: who.cookies });
        assert.equal(response.statusCode, 403, route.url);
        assert.deepEqual(response.json(), { error: "forbidden" });
      }
    }
  });

  it("still answers a malformed rename before a forbidden caller", async () => {
    const response = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}`,
      cookies: plain.cookies,
      payload: { name: "x" }
    });
    assert.equal(response.statusCode, 400);
  });

  it("keeps deleting the Server, the Invite trail and access links with the owner", async () => {
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Second" }
    });
    assert.equal(created.statusCode, 201);
    for (const request of [
      { method: "DELETE" as const, url: `/api/servers/${defaultServerId}` },
      { method: "GET" as const, url: `/api/servers/${defaultServerId}/invites` },
      { method: "POST" as const, url: `/api/servers/${defaultServerId}/members/${plain.user.id}/access-links` }
    ]) {
      const response = await app.server.inject({ ...request, cookies: admin.cookies });
      assert.equal(response.statusCode, 403, request.url);
    }
  });
});
