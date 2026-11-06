import { cookieJar } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Permission } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { defaultServerId, one } from "../src/db/database.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

/**
 * Members, voice and messages on Permissions, with rank (ADR-0038, ticket 05):
 * every action on a person needs the Permission and a target strictly below.
 */
describe("members, voice and messages on Permissions", () => {
  let app: VoxlyApp;
  let owner: Identity;
  let mod: Identity;
  let peer: Identity;
  let plain: Identity;
  let target: Identity;
  const server = `/api/servers/${defaultServerId}`;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "members-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "members-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    mod = await acceptInvite("Mod");
    peer = await acceptInvite("Peer");
    plain = await acceptInvite("Plain");
    target = await acceptInvite("Target");
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

  /** A Role with these Permissions, given to each of `who`. */
  async function roleFor(permissions: Permission[], ...who: Identity[]) {
    const created = await app.server.inject({
      method: "POST",
      url: `${server}/roles`,
      cookies: owner.cookies,
      payload: { name: `Role ${permissions.length}-${Math.random().toString(36).slice(2, 8)}` }
    });
    const roleId = created.json().role.id as string;
    await app.server.inject({
      method: "PATCH",
      url: `${server}/roles/${roleId}`,
      cookies: owner.cookies,
      payload: { permissions }
    });
    for (const member of who) {
      const given = await app.server.inject({
        method: "PUT",
        url: `${server}/members/${member.user.id}/roles/${roleId}`,
        cookies: owner.cookies
      });
      assert.equal(given.statusCode, 200);
    }
    return roleId;
  }

  const personRoutes = (userId: string) => [
    { method: "PATCH" as const, url: `${server}/members/${userId}/nickname`, payload: { nickname: "Renamed" } },
    { method: "PATCH" as const, url: `${server}/members/${userId}/voice-moderation`, payload: { muted: true } },
    { method: "POST" as const, url: `${server}/members/${userId}/kick` }
  ];

  it("accepts a holder who outranks the target and refuses a plain member, an equal rank and the owner", async () => {
    await roleFor(["manageMembers", "voiceModeration"], mod, peer);

    for (const route of personRoutes(target.user.id)) {
      const refused = await app.server.inject({ ...route, cookies: plain.cookies });
      assert.equal(refused.statusCode, 403, `plain ${route.method} ${route.url}`);
    }
    // Same Role, same rank: neither may act on the other.
    for (const route of personRoutes(peer.user.id)) {
      const refused = await app.server.inject({ ...route, cookies: mod.cookies });
      assert.equal(refused.statusCode, 403, `peer ${route.method} ${route.url}`);
    }
    // The owner is never the subject.
    for (const route of personRoutes(owner.user.id)) {
      const refused = await app.server.inject({ ...route, cookies: mod.cookies });
      // Voice moderation names the owner's own refusal; the rest answer 403.
      assert.equal(
        refused.statusCode,
        route.url.endsWith("nickname") ? 409 : route.url.endsWith("voice-moderation") ? 409 : 403,
        `owner ${route.method} ${route.url}`
      );
    }
    for (const route of personRoutes(target.user.id)) {
      const accepted = await app.server.inject({ ...route, cookies: mod.cookies });
      assert.ok(accepted.statusCode < 300, `mod ${route.method} ${route.url}: ${accepted.statusCode}`);
    }
  });

  it("lets Manage members ban and unban someone below, and refuses it without the Permission", async () => {
    await roleFor(["voiceModeration"], plain);
    await roleFor(["manageMembers"], mod);
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: `${server}/members/${target.user.id}/ban`,
          cookies: plain.cookies
        })
      ).statusCode,
      403
    );
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: `${server}/members/${target.user.id}/ban`,
          cookies: mod.cookies
        })
      ).statusCode,
      204
    );
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: `${server}/members/${target.user.id}/unban`,
          cookies: mod.cookies
        })
      ).statusCode,
      204
    );
  });

  it("keeps an Admin from kicking, banning, muting, moving or renaming another Admin", async () => {
    const adminRole = one<{ id: string }>(app.sqlite, "select id from roles where seed = 'admin' and server_id = ?", [
      defaultServerId
    ])!.id;
    for (const who of [mod, peer]) {
      await app.server.inject({
        method: "PUT",
        url: `${server}/members/${who.user.id}/roles/${adminRole}`,
        cookies: owner.cookies
      });
    }
    for (const route of [
      ...personRoutes(peer.user.id),
      { method: "POST" as const, url: `${server}/members/${peer.user.id}/ban` },
      {
        method: "POST" as const,
        url: `${server}/voice/members/${peer.user.id}/move`,
        payload: { roomId: `afk-${defaultServerId}` }
      },
      { method: "POST" as const, url: `${server}/voice/lobby/members/${peer.user.id}/disconnect` }
    ]) {
      const refused = await app.server.inject({ ...route, cookies: mod.cookies });
      assert.equal(refused.statusCode, 403, `${route.method} ${route.url}`);
    }
  });

  it("refuses move and disconnect without Voice moderation, and answers a holder past the rank check", async () => {
    await roleFor(["voiceModeration"], mod);
    for (const [who, status] of [
      [plain, 403],
      [mod, 409]
    ] as const) {
      // Nobody is in voice, so a holder who passes every check hears that.
      const disconnect = await app.server.inject({
        method: "POST",
        url: `${server}/voice/lobby/members/${target.user.id}/disconnect`,
        cookies: who.cookies
      });
      assert.equal(disconnect.statusCode, status);
      const move = await app.server.inject({
        method: "POST",
        url: `${server}/voice/members/${target.user.id}/move`,
        cookies: who.cookies,
        payload: { roomId: `afk-${defaultServerId}` }
      });
      assert.equal(move.statusCode, status);
    }
  });

  it("opens the member list to Manage members, Voice moderation or Manage roles, and to nobody else", async () => {
    assert.equal(
      (await app.server.inject({ method: "GET", url: `${server}/members`, cookies: plain.cookies })).statusCode,
      403
    );
    for (const permission of ["manageMembers", "voiceModeration", "manageRoles"] as const) {
      const who = await acceptInvite(`Lister ${permission}`);
      await roleFor([permission], who);
      const listed = await app.server.inject({ method: "GET", url: `${server}/members`, cookies: who.cookies });
      assert.equal(listed.statusCode, 200, permission);
    }
  });

  it("refuses ban, unban, move and disconnect on the owner and at an equal rank", async () => {
    await roleFor(["manageMembers", "voiceModeration"], mod, peer);
    // The owner bans the peer so there is someone to unban.
    await app.server.inject({ method: "POST", url: `${server}/members/${plain.user.id}/ban`, cookies: owner.cookies });
    for (const userId of [owner.user.id, peer.user.id]) {
      for (const route of [
        { method: "POST" as const, url: `${server}/members/${userId}/ban` },
        {
          method: "POST" as const,
          url: `${server}/voice/members/${userId}/move`,
          payload: { roomId: `afk-${defaultServerId}` }
        },
        { method: "POST" as const, url: `${server}/voice/lobby/members/${userId}/disconnect` },
        { method: "PATCH" as const, url: `${server}/members/${userId}/voice-moderation`, payload: { deafened: true } }
      ]) {
        const refused = await app.server.inject({ ...route, cookies: mod.cookies });
        const expected = userId === owner.user.id && route.url.endsWith("voice-moderation") ? 409 : 403;
        assert.equal(refused.statusCode, expected, `${route.method} ${route.url}`);
      }
    }
    // A plain member may not unban; a holder above the banned one may.
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: `${server}/members/${plain.user.id}/unban`,
          cookies: target.cookies
        })
      ).statusCode,
      403
    );
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: `${server}/members/${plain.user.id}/unban`,
          cookies: mod.cookies
        })
      ).statusCode,
      204
    );
  });

  it("still lets the owner ban someone they already kicked", async () => {
    await app.server.inject({
      method: "POST",
      url: `${server}/members/${target.user.id}/kick`,
      cookies: owner.cookies
    });
    const banned = await app.server.inject({
      method: "POST",
      url: `${server}/members/${target.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(banned.statusCode, 204);
  });

  it("lets Voice moderation mute a Bot and never move or kick it (ADR-0010)", async () => {
    await roleFor(["manageMembers", "voiceModeration"], mod);
    const botId = one<{ id: string }>(app.sqlite, "select id from users where is_bot = 1")!.id;
    const muted = await app.server.inject({
      method: "PATCH",
      url: `${server}/members/${botId}/voice-moderation`,
      cookies: mod.cookies,
      payload: { muted: true }
    });
    assert.equal(muted.statusCode, 200);
    for (const route of [
      { method: "POST" as const, url: `${server}/members/${botId}/kick` },
      {
        method: "POST" as const,
        url: `${server}/voice/members/${botId}/move`,
        payload: { roomId: `afk-${defaultServerId}` }
      }
    ]) {
      const refused = await app.server.inject({ ...route, cookies: mod.cookies });
      assert.equal(refused.statusCode, 409, route.url);
    }
  });

  it("lets Manage messages pin, clear reactions and delete someone else's message", async () => {
    await roleFor(["manageMessages"], mod);
    const posted = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: target.cookies,
      payload: { body: "hello" }
    });
    assert.equal(posted.statusCode, 201);
    const messageId = posted.json().message.id as string;
    const base = `/api/rooms/general/messages/${messageId}`;
    await app.server.inject({ method: "PUT", url: `${base}/reactions/👍`, cookies: target.cookies });

    for (const route of [
      { method: "PUT" as const, url: `${base}/pin` },
      { method: "DELETE" as const, url: `${base}/reactions/👍/all` },
      { method: "PATCH" as const, url: `${base}/embeds`, payload: { embedKey: "youtube:abc123" } },
      { method: "DELETE" as const, url: `${base}/reactions` },
      { method: "DELETE" as const, url: base }
    ]) {
      const refused = await app.server.inject({ ...route, cookies: plain.cookies });
      assert.equal(refused.statusCode, 403, `plain ${route.method} ${route.url}`);
    }
    for (const route of [
      { method: "PUT" as const, url: `${base}/pin` },
      { method: "DELETE" as const, url: `${base}/pin` },
      { method: "DELETE" as const, url: `${base}/reactions/👍/all` },
      { method: "PATCH" as const, url: `${base}/embeds`, payload: { embedKey: "youtube:abc123" } },
      { method: "DELETE" as const, url: `${base}/reactions` },
      { method: "DELETE" as const, url: base }
    ]) {
      const accepted = await app.server.inject({ ...route, cookies: mod.cookies });
      assert.ok(accepted.statusCode < 300, `mod ${route.method} ${route.url}: ${accepted.statusCode}`);
    }
  });
});
