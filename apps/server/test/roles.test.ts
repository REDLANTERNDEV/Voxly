import { cookieJar, sessionToken } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { io as createClient, type Socket } from "socket.io-client";
import { serverPermissions, type PresenceUser, type RoleSummary } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { all, defaultServerId, one, openDatabase, run } from "../src/db/database.js";
import { outranks, permissionsFor, rankOf } from "../src/members.js";
import { seedServerRoles } from "../src/roleSeeds.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

function rolesOf(sqlite: VoxlyApp["sqlite"], serverId: string) {
  return all<{ id: string; kind: string | null; seed: string | null; position: number }>(
    sqlite,
    "select id, kind, seed, position from roles where server_id = ? order by position desc",
    [serverId]
  );
}

describe("roles (ADR-0038)", () => {
  describe("seeding and the upgrade", () => {
    let directory: string | undefined;

    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    });

    it("gives every Server exactly one @everyone, Admin and Davetçi, and a restart changes nothing", async () => {
      directory = await mkdtemp(joinPath(tmpdir(), "voxly-roles-"));
      const path = joinPath(directory, "voxly.sqlite");
      const first = await openDatabase(path);
      const seeded = rolesOf(first.sqlite, defaultServerId);
      assert.deepEqual(
        seeded.map((role) => [role.kind, role.seed, role.position]),
        [
          ["admin", "admin", 2],
          [null, "recruiter", 1],
          ["everyone", "everyone", 0]
        ]
      );
      first.close();

      const second = await openDatabase(path);
      assert.deepEqual(rolesOf(second.sqlite, defaultServerId), seeded);
      second.close();
    });

    it("places every former can_invite member in Davetçi and nobody else", async () => {
      directory = await mkdtemp(joinPath(tmpdir(), "voxly-roles-"));
      const path = joinPath(directory, "legacy.sqlite");
      const legacy = await openDatabase(path);
      // Wind the file back to before Roles existed: no Roles, no marker, and
      // the old per-member switch set on two members.
      run(legacy.sqlite, "delete from member_roles");
      run(legacy.sqlite, "delete from roles");
      run(legacy.sqlite, "update servers set roles_seeded_at = null");
      for (const [id, role, canInvite] of [
        ["owner", "owner", 1],
        ["ada", "member", 1],
        ["ece", "member", 0],
        ["kicked", "member", 1]
      ] as const) {
        run(legacy.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", [id, id, role]);
        run(
          legacy.sqlite,
          "insert into server_members (server_id, user_id, role, can_invite, joined_at, removed_at) values (?, ?, ?, ?, ?, ?)",
          [defaultServerId, id, role, canInvite, "2026-01-01T00:00:00.000Z", id === "kicked" ? "2026-02-01" : null]
        );
      }
      legacy.close();

      const upgraded = await openDatabase(path);
      const recruiter = one<{ id: string }>(
        upgraded.sqlite,
        "select id from roles where server_id = ? and seed = 'recruiter'",
        [defaultServerId]
      )!;
      const holders = all<{ user_id: string }>(
        upgraded.sqlite,
        "select user_id from member_roles where role_id = ? order by user_id",
        [recruiter.id]
      ).map((row) => row.user_id);
      // The owner already holds everything; a kicked member's switch was inert.
      assert.deepEqual(holders, ["ada"]);
      assert.deepEqual(permissionsFor(upgraded.sqlite, defaultServerId, "ada"), ["createInvites"]);
      assert.deepEqual(permissionsFor(upgraded.sqlite, defaultServerId, "ece"), []);
      const everyone = one<{ permissions: string }>(
        upgraded.sqlite,
        "select permissions from roles where server_id = ? and kind = 'everyone'",
        [defaultServerId]
      )!;
      assert.equal(everyone.permissions, "[]");
      upgraded.close();
    });

    it("does not seed a Server twice even when its Davetçi was deleted", async () => {
      const database = await openDatabase(":memory:");
      run(database.sqlite, "delete from roles where server_id = ? and seed = 'recruiter'", [defaultServerId]);
      seedServerRoles(database.sqlite, defaultServerId, new Date().toISOString());
      assert.equal(rolesOf(database.sqlite, defaultServerId).length, 2);
      database.close();
    });
  });

  describe("the resolver", () => {
    it("gives the owner everything and the top rank, Admin everything, and a Bot nothing", async () => {
      const database = await openDatabase(":memory:");
      const { sqlite } = database;
      const roles = rolesOf(sqlite, defaultServerId);
      const admin = roles.find((role) => role.kind === "admin")!;
      const recruiter = roles.find((role) => role.seed === "recruiter")!;
      for (const [id, role, isBot] of [
        ["owner", "owner", 0],
        ["admin", "member", 0],
        ["recruiter", "member", 0],
        ["plain", "member", 0],
        ["bot", "member", 1]
      ] as const) {
        run(sqlite, "insert into users (id, nickname, role, is_bot) values (?, ?, ?, ?)", [id, id, role, isBot]);
        run(sqlite, "insert into server_members (server_id, user_id, role, joined_at) values (?, ?, ?, ?)", [
          defaultServerId,
          id,
          role,
          "2026-01-01T00:00:00.000Z"
        ]);
      }
      const give = (userId: string, roleId: string) =>
        run(sqlite, "insert into member_roles (server_id, user_id, role_id, granted_at) values (?, ?, ?, ?)", [
          defaultServerId,
          userId,
          roleId,
          "2026-01-01T00:00:00.000Z"
        ]);
      give("admin", admin.id);
      give("recruiter", recruiter.id);
      // Even a Role row naming a Bot gives it nothing.
      give("bot", admin.id);

      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "owner"), [...serverPermissions]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "admin"), [...serverPermissions]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "recruiter"), ["createInvites"]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "plain"), []);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "bot"), []);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "nobody"), []);

      // Permissions add up: @everyone's reach every member, and no Role takes one away.
      run(sqlite, "update roles set permissions = ? where server_id = ? and kind = 'everyone'", [
        JSON.stringify(["manageMessages", "notAPermission"]),
        defaultServerId
      ]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "plain"), ["manageMessages"]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "recruiter"), ["createInvites", "manageMessages"]);
      assert.deepEqual(permissionsFor(sqlite, defaultServerId, "bot"), []);

      assert.equal(rankOf(sqlite, defaultServerId, "owner"), admin.position + 1);
      assert.equal(rankOf(sqlite, defaultServerId, "admin"), admin.position);
      assert.equal(rankOf(sqlite, defaultServerId, "recruiter"), recruiter.position);
      assert.equal(rankOf(sqlite, defaultServerId, "plain"), 0);
      assert.equal(rankOf(sqlite, defaultServerId, "bot"), 0);

      assert.equal(outranks(sqlite, defaultServerId, "owner", "admin"), true);
      assert.equal(outranks(sqlite, defaultServerId, "admin", "recruiter"), true);
      assert.equal(outranks(sqlite, defaultServerId, "recruiter", "plain"), true);
      assert.equal(outranks(sqlite, defaultServerId, "plain", "plain"), false);
      assert.equal(outranks(sqlite, defaultServerId, "recruiter", "admin"), false);
      assert.equal(outranks(sqlite, defaultServerId, "admin", "owner"), false);
      assert.equal(outranks(sqlite, defaultServerId, "owner", "owner"), false);
      database.close();
    });
  });

  describe("over HTTP and realtime", () => {
    let app: VoxlyApp;
    let baseUrl: string;
    let sockets: Socket[] = [];
    let owner: Identity;

    beforeEach(async () => {
      app = await createVoxlyApp({
        databasePath: ":memory:",
        ownerBootstrapToken: "roles-fixture",
        allowHttpOwnerBootstrap: true,
        secureCookies: false
      });
      await app.server.listen({ host: "127.0.0.1", port: 0 });
      baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
      const bootstrap = await app.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "roles-fixture", nickname: "Owner" }
      });
      owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
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

    async function serverRoles(who: Identity) {
      const response = await app.server.inject({
        method: "GET",
        url: `/api/servers/${defaultServerId}/roles`,
        cookies: who.cookies
      });
      assert.equal(response.statusCode, 200);
      return response.json() as { roles: RoleSummary[]; permissions: string[]; rank: number };
    }

    async function roleId(seed: "everyone" | "admin" | "recruiter") {
      return one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and seed = ?", [
        defaultServerId,
        seed
      ])!.id;
    }

    function setRole(who: Identity, userId: string, id: string, give: boolean) {
      return app.server.inject({
        method: give ? "PUT" : "DELETE",
        url: `/api/servers/${defaultServerId}/members/${userId}/roles/${id}`,
        cookies: who.cookies
      });
    }

    function createInvite(who: Identity) {
      return app.server.inject({
        method: "POST",
        url: `/api/servers/${defaultServerId}/invites`,
        cookies: who.cookies,
        payload: { label: "Friends", expiresInMinutes: 1440 }
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

    it("lists the Roles highest first with what they make the caller", async () => {
      const member = await acceptInvite("Ada");
      const asMember = await serverRoles(member);
      assert.deepEqual(
        asMember.roles.map((role) => [role.kind, role.name, role.position]),
        [
          ["admin", null, 2],
          [null, null, 1],
          ["everyone", null, 0]
        ]
      );
      assert.deepEqual(asMember.roles.find((role) => role.kind === "admin")?.permissions, ["administrator"]);
      assert.deepEqual(asMember.permissions, []);
      assert.equal(asMember.rank, 0);
      const asOwner = await serverRoles(owner);
      assert.deepEqual(asOwner.permissions, [...serverPermissions]);
      assert.equal(asOwner.rank, 3);

      const servers = await app.server.inject({ method: "GET", url: "/api/servers", cookies: member.cookies });
      const summary = servers.json().servers.find((server: { id: string }) => server.id === defaultServerId);
      assert.deepEqual(summary.permissions, []);
      assert.equal(summary.rank, 0);
      assert.equal("canInvite" in summary, false);
    });

    it("refuses a stranger the Role list", async () => {
      const stranger = await app.server.inject({ method: "GET", url: `/api/servers/${defaultServerId}/roles` });
      assert.equal(stranger.statusCode, 401);
    });

    it("lets Create invites decide who may invite, from any Role or from @everyone", async () => {
      const member = await acceptInvite("Ada");
      assert.equal((await createInvite(member)).statusCode, 403);

      assert.equal((await setRole(owner, member.user.id, await roleId("recruiter"), true)).statusCode, 200);
      assert.equal((await createInvite(member)).statusCode, 201);
      assert.deepEqual((await serverRoles(member)).permissions, ["createInvites"]);

      const other = await acceptInvite("Ece");
      assert.equal((await createInvite(other)).statusCode, 403);
      run(app.sqlite, "update roles set permissions = ? where server_id = ? and kind = 'everyone'", [
        JSON.stringify(["createInvites"]),
        defaultServerId
      ]);
      assert.equal((await createInvite(other)).statusCode, 201);
    });

    it("lets the owner give and remove Davetçi, and removing it takes the member's invites with it", async () => {
      const member = await acceptInvite("Ada");
      const recruiter = await roleId("recruiter");
      const given = await setRole(owner, member.user.id, recruiter, true);
      assert.equal(given.statusCode, 200);
      assert.deepEqual((given.json().user as PresenceUser).roleIds, [recruiter]);
      // Giving a Role already held changes nothing.
      assert.equal((await setRole(owner, member.user.id, recruiter, true)).statusCode, 200);

      const invite = await createInvite(member);
      assert.equal(invite.statusCode, 201);

      const removed = await setRole(owner, member.user.id, recruiter, false);
      assert.equal(removed.statusCode, 200);
      assert.deepEqual((removed.json().user as PresenceUser).roleIds, []);
      assert.equal((await createInvite(member)).statusCode, 403);
      const stored = one<{ revoked_at: string | null }>(app.sqlite, "select revoked_at from invites where id = ?", [
        invite.json().invite.id
      ]);
      assert.notEqual(stored?.revoked_at, null);

      const audits = all<{ action: string }>(
        app.sqlite,
        "select action from audit_events where action like 'role.%' order by created_at"
      ).map((row) => row.action);
      assert.deepEqual(audits, ["role.given", "role.removed"]);
    });

    it("refuses every Role action the rules forbid with one generic 403", async () => {
      const admin = await acceptInvite("Admin");
      const recruiterHolder = await acceptInvite("Recruiter");
      const plain = await acceptInvite("Plain");
      const adminRole = await roleId("admin");
      const recruiter = await roleId("recruiter");
      const everyone = await roleId("everyone");
      assert.equal((await setRole(owner, admin.user.id, adminRole, true)).statusCode, 200);
      assert.equal((await setRole(owner, recruiterHolder.user.id, recruiter, true)).statusCode, 200);

      // A Role below Davetçi, so an Admin has something they may give.
      const helperId = crypto.randomUUID();
      run(
        app.sqlite,
        "insert into roles (id, server_id, name, position, permissions, created_at) values (?, ?, 'Helper', 1, '[]', ?)",
        [helperId, defaultServerId, new Date().toISOString()]
      );
      run(app.sqlite, "update roles set position = position + 1 where server_id = ? and id in (?, ?)", [
        defaultServerId,
        recruiter,
        adminRole
      ]);

      const botId = one<{ id: string }>(app.sqlite, "select id from users where is_bot = 1")!.id;
      const refusals: Array<[string, Identity, string, string, boolean]> = [
        ["a member without Manage roles", plain, recruiterHolder.user.id, helperId, true],
        ["@everyone, given", owner, plain.user.id, everyone, true],
        ["@everyone, removed", owner, plain.user.id, everyone, false],
        ["Admin, by an Admin", admin, plain.user.id, adminRole, true],
        ["Admin, removed by an Admin", admin, admin.user.id, adminRole, false],
        ["a target at the actor's rank", admin, admin.user.id, helperId, true],
        ["the owner as target", admin, owner.user.id, helperId, true],
        ["the owner as target, by the owner", owner, owner.user.id, helperId, true],
        ["a Bot", owner, botId, helperId, true]
      ];
      for (const [reason, actor, target, role, give] of refusals) {
        const response = await setRole(actor, target, role, give);
        assert.equal(response.statusCode, 403, reason);
        assert.deepEqual(response.json(), { error: "forbidden" }, reason);
      }

      // A Role at or above the actor's own rank: Admin made Davetçi's holder
      // able to manage roles, and they may not give Davetçi itself.
      run(app.sqlite, "update roles set permissions = ? where id = ?", [
        JSON.stringify(["createInvites", "manageRoles"]),
        recruiter
      ]);
      assert.equal((await setRole(recruiterHolder, plain.user.id, recruiter, true)).statusCode, 403);
      assert.equal((await setRole(recruiterHolder, plain.user.id, helperId, true)).statusCode, 200);
      // And not a target at their own rank.
      assert.equal((await setRole(recruiterHolder, recruiterHolder.user.id, helperId, true)).statusCode, 403);

      // An Admin gives what is below them to someone below them.
      assert.equal((await setRole(admin, plain.user.id, recruiter, true)).statusCode, 200);
      assert.equal((await setRole(admin, plain.user.id, recruiter, false)).statusCode, 200);

      assert.equal((await setRole(owner, plain.user.id, crypto.randomUUID(), true)).statusCode, 404);
    });

    it("takes a member's Roles with them when they are kicked, so rejoining restores nothing", async () => {
      const member = await acceptInvite("Ada");
      await setRole(owner, member.user.id, await roleId("recruiter"), true);
      const kicked = await app.server.inject({
        method: "POST",
        url: `/api/servers/${defaultServerId}/members/${member.user.id}/kick`,
        cookies: owner.cookies
      });
      assert.equal(kicked.statusCode, 204);
      assert.equal(
        one<{ count: number }>(app.sqlite, "select count(*) as count from member_roles where user_id = ?", [
          member.user.id
        ])?.count,
        0
      );
    });

    it("gives a new Server its three Roles and deletes them with it", async () => {
      const created = await app.server.inject({
        method: "POST",
        url: "/api/servers",
        cookies: owner.cookies,
        payload: { name: "Friday Games" }
      });
      assert.equal(created.statusCode, 201);
      const serverId = created.json().server.id as string;
      assert.deepEqual(created.json().server.permissions, [...serverPermissions]);
      assert.deepEqual(
        rolesOf(app.sqlite, serverId).map((role) => role.seed),
        ["admin", "recruiter", "everyone"]
      );
      const deleted = await app.server.inject({
        method: "DELETE",
        url: `/api/servers/${serverId}`,
        cookies: owner.cookies,
        payload: { confirmName: "Friday Games" }
      });
      assert.equal(deleted.statusCode, 204);
      assert.equal(rolesOf(app.sqlite, serverId).length, 0);
    });

    it("tells every member of the Server when someone's Roles change", async () => {
      const member = await acceptInvite("Ada");
      const watcher = await acceptInvite("Ece");
      const socket = await connect(watcher);
      const rolesChanged = new Promise<{ serverId: string }>((resolve) => socket.once("server:rolesChanged", resolve));
      const memberUpdated = new Promise<{ serverId: string; user: PresenceUser }>((resolve) =>
        socket.once("server:memberUpdated", resolve)
      );
      const recruiter = await roleId("recruiter");
      assert.equal((await setRole(owner, member.user.id, recruiter, true)).statusCode, 200);
      assert.deepEqual(await rolesChanged, { serverId: defaultServerId });
      const updated = await memberUpdated;
      assert.equal(updated.user.userId, member.user.id);
      assert.deepEqual(updated.user.roleIds, [recruiter]);

      const directory = await app.server.inject({
        method: "GET",
        url: `/api/servers/${defaultServerId}/directory`,
        cookies: watcher.cookies
      });
      const listed = directory.json().members.find((entry: PresenceUser) => entry.userId === member.user.id);
      assert.deepEqual(listed.roleIds, [recruiter]);
    });
  });
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
