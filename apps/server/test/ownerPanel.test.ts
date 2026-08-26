import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import Fastify from "fastify";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { registerOwnerPanelRoutes } from "../src/ownerPanel.js";
import type { RealtimeModeration, RouteContext } from "../src/http.js";
import { all, defaultServerId, one, openDatabase, type VoxlyDatabase } from "../src/db/database.js";
import type { VoxlyIoServer } from "../src/socket.js";

type AuditRow = { action: string; target_user_id: string | null; actor_user_id: string | null };

describe("the owner panel", () => {
  let app: VoxlyApp;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function auditRows(action: string) {
    return all<AuditRow>(
      app.sqlite,
      "select action, target_user_id, actor_user_id from audit_events where action = ?",
      [action]
    );
  }

  function bannedAt(userId: string) {
    return one<{ banned_at: string | null }>(app.sqlite, "select banned_at from users where id = ?", [
      userId
    ])?.banned_at ?? null;
  }

  describe("the routes it registers", () => {
    let database: VoxlyDatabase | undefined;

    afterEach(() => {
      database?.close();
      database = undefined;
    });

    it("owns the global-owner panel, and nothing beyond it", async () => {
      database = await openDatabase(":memory:");
      const http = Fastify();
      const registered: string[] = [];
      http.addHook("onRoute", (route) => {
        registered.push(`${String(route.method)} ${route.url}`);
      });

      registerOwnerPanelRoutes({
        fastify: http,
        database,
        // Registration touches neither; the handlers that reach for `realtime`
        // are covered below and by app.test.ts.
        io: {} as VoxlyIoServer,
        realtime: {} as RealtimeModeration,
        secureCookies: true
      } satisfies RouteContext);
      await http.close();

      // Fastify pairs a HEAD with every GET; the point of the assertion is the
      // set of paths this module claims. `/api/owner/invites` is deliberately
      // absent — those three are the server invite operations over
      // `defaultServerId` and belong to `invites.ts`, which asserts them — and
      // the server-scoped membership moderation routes are absent for the
      // opposite reason: they answer to server ownership, not the global role.
      assert.deepEqual(registered.sort(), [
        "GET /api/owner/sessions",
        "GET /api/owner/users",
        "HEAD /api/owner/sessions",
        "HEAD /api/owner/users",
        "POST /api/owner/sessions/:sessionId/revoke",
        "POST /api/owner/users/:userId/ban"
      ]);
    });
  });

  /**
   * The two lists answer different questions and are meant to. `/api/owner/users`
   * joins from `server_members` scoped to the default server, so it means "who is
   * in this server" — the Music bot included. `/api/owner/sessions` is global.
   *
   * The consequence is visible rather than theoretical: an owner can see a
   * session belonging to somebody their user list does not mention, and cannot
   * ban that person from this panel. These are the tests that fail if the two
   * are ever harmonized as a tidy-up rather than as a decision.
   */
  describe("who the two lists are about", () => {
    it("lists the default server's members, and every session anywhere", async () => {
      const owner = await bootstrapOwner(app);
      const elsewhere = await createServer(app, owner.cookies, "Elsewhere");
      const stranger = await acceptServerInvite(app, owner.cookies, elsewhere, "Elsewhere Only");

      const users = await app.server.inject({ method: "GET", url: "/api/owner/users", cookies: owner.cookies });
      const sessions = await app.server.inject({ method: "GET", url: "/api/owner/sessions", cookies: owner.cookies });

      // The bot is a member of the default server, so it is a user here.
      assert.deepEqual(
        (users.json().users as Array<{ nickname: string }>).map((user) => user.nickname).sort(),
        ["Music", "Owner"]
      );
      // Someone who joined a different server has no membership row in the
      // default server and so appears in neither the list nor anything an owner
      // could ban them with — but their session is right there.
      assert.deepEqual(
        (sessions.json().sessions as Array<{ nickname: string }>).map((session) => session.nickname).sort(),
        ["Elsewhere Only", "Owner"]
      );
      assert.equal(
        (users.json().users as Array<{ id: string }>).some((user) => user.id === stranger.user.id),
        false
      );
      assert.equal(
        (sessions.json().sessions as Array<{ userId: string }>).some((session) => session.userId === stranger.user.id),
        true
      );
    });

    it("keeps a banned member in the user list so the ban can be seen", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Selin");

      const banned = await app.server.inject({
        method: "POST",
        url: `/api/servers/${defaultServerId}/members/${member.user.id}/ban`,
        cookies: owner.cookies
      });
      assert.equal(banned.statusCode, 204);

      const users = await app.server.inject({ method: "GET", url: "/api/owner/users", cookies: owner.cookies });
      const listed = (users.json().users as Array<{ id: string; bannedAt: string | null }>)
        .find((user) => user.id === member.user.id);
      assert.ok(listed);
      assert.notEqual(listed.bannedAt, null);
    });
  });

  /**
   * The global ban exempts owners and does nothing at all for an id that names
   * nobody — but it answers 204 and writes its audit line either way. Both are
   * long-standing behaviour rather than intent, and both are recorded here
   * exactly as they are, because the handler states its exemption twice — once
   * in the update's where clause, once in the cascade — with the `audit()` call
   * outside both, and collapsing the three into one is the obvious tidy.
   * Changing what the caller or the audit log is told is a behaviour change and
   * belongs to its own ticket; until then these are the tests that make the
   * change deliberate.
   */
  describe("a ban that does not happen", () => {
    it("leaves an owner banned nowhere, still signed in, and still audited", async () => {
      const owner = await bootstrapOwner(app);
      const second = await acceptInvite(app, owner.cookies, "Deniz");
      // There is no HTTP path to a second owner — bootstrap makes one and the
      // recovery CLI only ever finds the existing one — so the role is granted
      // the way the route reads it. `users.role` is the global role the ban
      // exempts; the membership row stays an ordinary member's.
      app.sqlite.prepare("update users set role = 'owner' where id = ?").run(second.user.id);

      const response = await app.server.inject({
        method: "POST",
        url: `/api/owner/users/${second.user.id}/ban`,
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 204);
      assert.equal(bannedAt(second.user.id), null);
      // The session cascade is skipped for the same exemption, so the owner who
      // was "banned" is still holding a working session.
      const me = await app.server.inject({ method: "GET", url: "/api/me", cookies: second.cookies });
      assert.equal(me.statusCode, 200);
      // And the audit log says otherwise. Recorded, not endorsed.
      assert.deepEqual(
        auditRows("user.banned").map((row) => row.target_user_id),
        [second.user.id]
      );
    });

    it("answers a user id that names nobody the same way, audit line and all", async () => {
      const owner = await bootstrapOwner(app);
      const nobody = "00000000-0000-4000-8000-000000000000";

      const response = await app.server.inject({
        method: "POST",
        url: `/api/owner/users/${nobody}/ban`,
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 204);
      assert.equal(all(app.sqlite, "select id from users where id = ?", [nobody]).length, 0);
      assert.deepEqual(
        auditRows("user.banned").map((row) => row.target_user_id),
        [nobody]
      );
    });

    it("still bans an ordinary member outright, sessions and all", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Ada");

      const response = await app.server.inject({
        method: "POST",
        url: `/api/owner/users/${member.user.id}/ban`,
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 204);
      assert.notEqual(bannedAt(member.user.id), null);
      const me = await app.server.inject({ method: "GET", url: "/api/me", cookies: member.cookies });
      assert.equal(me.statusCode, 401);
    });

    it("refuses a member id that is not a UUID before it bans anything", async () => {
      const owner = await bootstrapOwner(app);

      const response = await app.server.inject({
        method: "POST",
        url: "/api/owner/users/not-a-uuid/ban",
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 400);
      assert.equal(auditRows("user.banned").length, 0);
    });
  });

  describe("closing a session", () => {
    it("ends the named session and audits it", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Selin");
      const sessions = await app.server.inject({ method: "GET", url: "/api/owner/sessions", cookies: owner.cookies });
      const memberSession = (sessions.json().sessions as Array<{ id: string; userId: string }>)
        .find((session) => session.userId === member.user.id);
      assert.ok(memberSession);

      const response = await app.server.inject({
        method: "POST",
        url: `/api/owner/sessions/${memberSession.id}/revoke`,
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 204);
      const me = await app.server.inject({ method: "GET", url: "/api/me", cookies: member.cookies });
      assert.equal(me.statusCode, 401);
      assert.deepEqual(
        auditRows("session.revoked").map((row) => row.target_user_id),
        [memberSession.id]
      );
    });

    it("answers a session id that names nothing with the same 204 and the same audit line", async () => {
      const owner = await bootstrapOwner(app);
      const nothing = "00000000-0000-4000-8000-000000000000";

      const response = await app.server.inject({
        method: "POST",
        url: `/api/owner/sessions/${nothing}/revoke`,
        cookies: owner.cookies
      });

      assert.equal(response.statusCode, 204);
      assert.equal(all(app.sqlite, "select id from sessions where id = ?", [nothing]).length, 0);
      assert.deepEqual(
        auditRows("session.revoked").map((row) => row.target_user_id),
        [nothing]
      );
    });
  });

  /** The panel is global-owner only; a member is refused every one of the four. */
  describe("who may open it at all", () => {
    it("refuses a member each route, and an anonymous caller before that", async () => {
      const owner = await bootstrapOwner(app);
      const member = await acceptInvite(app, owner.cookies, "Ada");
      const requests = [
        { method: "GET" as const, url: "/api/owner/users" },
        { method: "GET" as const, url: "/api/owner/sessions" },
        { method: "POST" as const, url: `/api/owner/users/${member.user.id}/ban` },
        { method: "POST" as const, url: "/api/owner/sessions/00000000-0000-4000-8000-000000000000/revoke" }
      ];

      for (const request of requests) {
        const forbidden = await app.server.inject({ ...request, cookies: member.cookies });
        assert.equal(forbidden.statusCode, 403, `${request.method} ${request.url}`);
        const unauthorized = await app.server.inject(request);
        assert.equal(unauthorized.statusCode, 401, `${request.method} ${request.url}`);
      }
    });
  });
});

async function bootstrapOwner(app: VoxlyApp) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

async function createServer(app: VoxlyApp, ownerCookies: Record<string, string>, name: string) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/servers",
    cookies: ownerCookies,
    payload: { name }
  });
  assert.equal(response.statusCode, 201);
  return response.json().server.id as string;
}

async function acceptInvite(app: VoxlyApp, ownerCookies: Record<string, string>, nickname: string) {
  const inviteResponse = await app.server.inject({
    method: "POST",
    url: "/api/owner/invites",
    cookies: ownerCookies,
    payload: { label: `${nickname} invite` }
  });

  return accept(app, inviteResponse.json().invite.token as string, nickname);
}

async function acceptServerInvite(
  app: VoxlyApp,
  ownerCookies: Record<string, string>,
  serverId: string,
  nickname: string
) {
  const inviteResponse = await app.server.inject({
    method: "POST",
    url: `/api/servers/${serverId}/invites`,
    cookies: ownerCookies,
    payload: { label: `${nickname} invite` }
  });
  assert.equal(inviteResponse.statusCode, 201);

  return accept(app, inviteResponse.json().invite.token as string, nickname);
}

async function accept(app: VoxlyApp, inviteToken: string, nickname: string) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/invites/accept",
    payload: { inviteToken, nickname }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
