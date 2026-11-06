import { cookieJar } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Permission } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { defaultServerId } from "../src/db/database.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

/** Channels run on Manage channels and Invites on Manage invites (ADR-0038, ticket 04). */
describe("channels and invites on Permissions", () => {
  let app: VoxlyApp;
  let owner: Identity;
  let holder: Identity;
  let plain: Identity;
  const server = `/api/servers/${defaultServerId}`;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "permission-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "permission-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    holder = await acceptInvite("Holder");
    plain = await acceptInvite("Plain");
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

  /** Gives `holder` a Role carrying exactly these Permissions. */
  async function grant(permissions: Permission[]) {
    const created = await app.server.inject({
      method: "POST",
      url: `${server}/roles`,
      cookies: owner.cookies,
      payload: { name: "Holders" }
    });
    const roleId = created.json().role.id as string;
    await app.server.inject({
      method: "PATCH",
      url: `${server}/roles/${roleId}`,
      cookies: owner.cookies,
      payload: { permissions }
    });
    const given = await app.server.inject({
      method: "PUT",
      url: `${server}/members/${holder.user.id}/roles/${roleId}`,
      cookies: owner.cookies
    });
    assert.equal(given.statusCode, 200);
  }

  async function makeRoom(who: Identity, name: string) {
    return app.server.inject({
      method: "POST",
      url: `${server}/rooms`,
      cookies: who.cookies,
      payload: { name, kind: "text" }
    });
  }

  async function makeCategory(who: Identity, name: string) {
    return app.server.inject({ method: "POST", url: `${server}/categories`, cookies: who.cookies, payload: { name } });
  }

  it("lets a Manage channels holder run every channel and category route, and refuses a plain member each", async () => {
    await grant(["manageChannels"]);
    // Refusals first, while there is something to refuse on.
    const ownerRoom = (await makeRoom(owner, "spare")).json().room.id as string;
    const ownerCategory = (await makeCategory(owner, "Spare")).json().category.id as string;
    const rooms = await app.server.inject({ method: "GET", url: `${server}/rooms`, cookies: owner.cookies });
    const layout = {
      groups: [
        { categoryId: null, roomIds: rooms.json().rooms.map((room: { id: string }) => room.id) },
        { categoryId: ownerCategory, roomIds: [] }
      ]
    };
    // The layout names every channel as it stands, so it goes first.
    const routes = [
      { method: "PATCH" as const, url: `${server}/layout`, payload: layout },
      { method: "POST" as const, url: `${server}/rooms`, payload: { name: "plain", kind: "text" } },
      { method: "POST" as const, url: `${server}/categories`, payload: { name: "Plain" } },
      { method: "PATCH" as const, url: `${server}/categories/${ownerCategory}`, payload: { name: "Renamed" } },
      { method: "PATCH" as const, url: `${server}/rooms/${ownerRoom}`, payload: { name: "renamed" } },
      {
        method: "PUT" as const,
        url: `${server}/rooms/${ownerRoom}/access`,
        // Still one they can enter, so they may go on to delete it.
        payload: { isPrivate: true, listed: false, userIds: [holder.user.id] }
      },
      { method: "DELETE" as const, url: `${server}/categories/${ownerCategory}` },
      { method: "DELETE" as const, url: `${server}/rooms/${ownerRoom}` }
    ];
    for (const route of routes) {
      const refused = await app.server.inject({ ...route, cookies: plain.cookies });
      assert.equal(refused.statusCode, 403, `plain ${route.method} ${route.url}`);
      const accepted = await app.server.inject({ ...route, cookies: holder.cookies });
      assert.ok(accepted.statusCode < 300, `holder ${route.method} ${route.url}: ${accepted.statusCode}`);
    }
  });

  it("refuses the list, revoking and a permanent link to anyone without Manage invites", async () => {
    const someone = await app.server.inject({
      method: "POST",
      url: `${server}/invites`,
      cookies: owner.cookies,
      payload: { label: "Owner link", expiresInMinutes: 1440 }
    });
    const inviteId = someone.json().invite.id as string;
    const permanent = { label: "Forever", expiresInMinutes: null };

    for (const who of [plain]) {
      assert.equal(
        (await app.server.inject({ method: "GET", url: `${server}/invites`, cookies: who.cookies })).statusCode,
        403
      );
      assert.equal(
        (await app.server.inject({ method: "POST", url: `${server}/invites/${inviteId}/revoke`, cookies: who.cookies }))
          .statusCode,
        403
      );
    }
    // Create invites alone makes links that expire, never a permanent one.
    await grant(["createInvites"]);
    const refusedPermanent = await app.server.inject({
      method: "POST",
      url: `${server}/invites`,
      cookies: holder.cookies,
      payload: permanent
    });
    assert.equal(refusedPermanent.statusCode, 403);
    assert.equal(
      (await app.server.inject({ method: "GET", url: `${server}/invites`, cookies: holder.cookies })).statusCode,
      403
    );
    for (const who of [plain, holder]) {
      const revoke = await app.server.inject({
        method: "POST",
        url: `${server}/invites/${inviteId}/revoke`,
        cookies: who.cookies
      });
      assert.equal(revoke.statusCode, 403);
    }
    // The owner holds every Permission, so a permanent link is theirs to make.
    const ownerPermanent = await app.server.inject({
      method: "POST",
      url: `${server}/invites`,
      cookies: owner.cookies,
      payload: permanent
    });
    assert.equal(ownerPermanent.statusCode, 201);
  });

  it("lets Manage channels reach only the channels its holder can enter, and drag around Hidden ones", async () => {
    await grant(["manageChannels"]);
    const secret = (await makeRoom(owner, "secret")).json().room.id as string;
    const listed = (await makeRoom(owner, "listed")).json().room.id as string;
    for (const [roomId, isListed] of [
      [secret, false],
      [listed, true]
    ] as const) {
      await app.server.inject({
        method: "PUT",
        url: `${server}/rooms/${roomId}/access`,
        cookies: owner.cookies,
        payload: { isPrivate: true, listed: isListed, userIds: [] }
      });
    }
    const access = { isPrivate: true, listed: false, userIds: [holder.user.id] };
    for (const [roomId, status] of [
      [secret, 404],
      [listed, 403]
    ] as const) {
      for (const route of [
        { method: "PUT" as const, url: `${server}/rooms/${roomId}/access`, payload: access },
        { method: "PATCH" as const, url: `${server}/rooms/${roomId}`, payload: { name: "mine" } },
        { method: "DELETE" as const, url: `${server}/rooms/${roomId}` }
      ]) {
        const response = await app.server.inject({ ...route, cookies: holder.cookies });
        assert.equal(response.statusCode, status, `${route.method} ${route.url}`);
      }
    }
    // The layout names what the holder sees; the Hidden channel keeps its place.
    const seen = await app.server.inject({ method: "GET", url: `${server}/rooms`, cookies: holder.cookies });
    const ids = (seen.json().rooms as Array<{ id: string }>).map((room) => room.id);
    assert.equal(ids.includes(secret), false);
    const reordered = await app.server.inject({
      method: "PATCH",
      url: `${server}/layout`,
      cookies: holder.cookies,
      payload: { groups: [{ categoryId: null, roomIds: [...ids].reverse() }] }
    });
    assert.equal(reordered.statusCode, 200);
    const asOwner = await app.server.inject({ method: "GET", url: `${server}/rooms`, cookies: owner.cookies });
    assert.ok((asOwner.json().rooms as Array<{ id: string }>).some((room) => room.id === secret));
  });

  it("gives a Manage invites holder the list without the owner's Invite trail", async () => {
    await grant(["createInvites", "manageInvites"]);
    await app.server.inject({
      method: "POST",
      url: `${server}/invites`,
      cookies: owner.cookies,
      payload: { label: "Owner link", expiresInMinutes: 1440 }
    });
    const permanent = await app.server.inject({
      method: "POST",
      url: `${server}/invites`,
      cookies: holder.cookies,
      payload: { label: "Forever", expiresInMinutes: null }
    });
    assert.equal(permanent.statusCode, 201);

    const listed = await app.server.inject({ method: "GET", url: `${server}/invites`, cookies: holder.cookies });
    assert.equal(listed.statusCode, 200);
    const invites = listed.json().invites as Array<Record<string, unknown> & { id: string; label: string }>;
    assert.ok(invites.length >= 2);
    for (const invite of invites) {
      // Nothing that names who made it or who came through it (ADR-0034).
      assert.equal(invite.createdBy, null);
      assert.equal(invite.createdByUserId, null);
      assert.equal(invite.usedByUserId, null);
      assert.equal(invite.usedAt, null);
      assert.deepEqual(invite.uses, []);
    }
    const asOwner = await app.server.inject({ method: "GET", url: `${server}/invites`, cookies: owner.cookies });
    assert.notEqual(asOwner.json().invites[0].createdBy, null);

    const ownerLink = invites.find((invite) => invite.label === "Owner link")!;
    const revoked = await app.server.inject({
      method: "POST",
      url: `${server}/invites/${ownerLink.id}/revoke`,
      cookies: holder.cookies
    });
    assert.equal(revoked.statusCode, 204);
  });
});
