import { cookieJar, sessionToken } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { RoleSummary } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { all, defaultServerId, one } from "../src/db/database.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };

/** Creating, editing, reordering and deleting Roles (ADR-0038, design decisions 1, 5–7, 17). */
describe("the Role editor's routes", () => {
  let app: VoxlyApp;
  let baseUrl: string;
  let sockets: Socket[] = [];
  let owner: Identity;
  let admin: Identity;
  let plain: Identity;
  const base = `/api/servers/${defaultServerId}/roles`;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "editor-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    await app.server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.server.address() as { port: number }).port}`;
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "editor-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    admin = await acceptInvite("Admin");
    plain = await acceptInvite("Plain");
    const given = await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${admin.user.id}/roles/${seeded("admin")}`,
      cookies: owner.cookies
    });
    assert.equal(given.statusCode, 200);
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

  function seeded(seed: "everyone" | "admin" | "recruiter") {
    return one<{ id: string }>(app.sqlite, "select id from roles where server_id = ? and seed = ?", [
      defaultServerId,
      seed
    ])!.id;
  }

  function roles() {
    return all<{ id: string; name: string | null; position: number; kind: string | null }>(
      app.sqlite,
      "select id, name, position, kind from roles where server_id = ? order by position desc",
      [defaultServerId]
    );
  }

  function create(who: Identity, name: string) {
    return app.server.inject({ method: "POST", url: base, cookies: who.cookies, payload: { name } });
  }

  function update(who: Identity, roleId: string, payload: Record<string, unknown>) {
    return app.server.inject({ method: "PATCH", url: `${base}/${roleId}`, cookies: who.cookies, payload });
  }

  function reorder(who: Identity, roleIds: string[]) {
    return app.server.inject({ method: "PUT", url: `${base}/order`, cookies: who.cookies, payload: { roleIds } });
  }

  function remove(who: Identity, roleId: string) {
    return app.server.inject({ method: "DELETE", url: `${base}/${roleId}`, cookies: who.cookies });
  }

  it("creates a Role just above @everyone, keeps Admin first, and refuses a plain member", async () => {
    const created = await create(admin, "Helpers");
    assert.equal(created.statusCode, 201);
    const role = created.json().role as RoleSummary;
    assert.equal(role.name, "Helpers");
    assert.equal(role.position, 1);
    assert.deepEqual(role.permissions, []);
    assert.deepEqual(
      roles().map((row) => row.kind ?? row.name),
      ["admin", null, "Helpers", "everyone"].map((value) => value ?? null)
    );
    assert.deepEqual(
      roles().map((row) => row.position),
      [3, 2, 1, 0]
    );
    assert.equal((await create(plain, "Nope")).statusCode, 403);
  });

  it("refuses an empty or 33-character name, and the 51st Role, with a clear answer", async () => {
    assert.equal((await create(owner, "")).statusCode, 400);
    assert.equal((await create(owner, "x".repeat(33))).statusCode, 400);
    assert.equal((await create(owner, "x".repeat(32))).statusCode, 201);
    // Three seeded and one just made: 46 more reach the ceiling of 50.
    for (let index = 0; index < 46; index += 1) {
      assert.equal((await create(owner, `Role ${index}`)).statusCode, 201);
    }
    const refused = await create(owner, "One too many");
    assert.equal(refused.statusCode, 409);
    assert.deepEqual(refused.json(), { error: "role_limit_reached" });
  });

  it("lets an Admin edit Roles below them, but never Admin itself or Administrator anywhere", async () => {
    const helpers = (await create(admin, "Helpers")).json().role as RoleSummary;
    const edited = await update(admin, helpers.id, {
      name: "Helpers 2",
      color: "#2f9e5b",
      separate: true,
      permissions: ["createInvites", "manageMessages"]
    });
    assert.equal(edited.statusCode, 200);
    assert.deepEqual(edited.json().role, {
      ...helpers,
      name: "Helpers 2",
      color: "#2f9e5b",
      separate: true,
      permissions: ["createInvites", "manageMessages"]
    });

    for (const payload of [{ name: "Boss" }, { color: "#d93f3f" }, { permissions: [] }]) {
      const response = await update(admin, seeded("admin"), payload);
      assert.equal(response.statusCode, 403, JSON.stringify(payload));
    }
    assert.equal((await update(admin, helpers.id, { permissions: ["administrator"] })).statusCode, 403);
    assert.equal((await update(admin, seeded("everyone"), { permissions: ["createInvites"] })).statusCode, 200);
    assert.equal((await update(plain, helpers.id, { name: "Mine" })).statusCode, 403);
  });

  it("never lets someone switch on a Permission they do not hold themselves", async () => {
    // A member holding Manage roles through Davetçi, who also holds a lower Role.
    const recruiter = seeded("recruiter");
    await update(owner, recruiter, { permissions: ["createInvites", "manageRoles"] });
    const mod = await acceptInvite("Mod");
    const helpers = (await create(owner, "Helpers")).json().role as RoleSummary;
    for (const roleId of [recruiter, helpers.id]) {
      await app.server.inject({
        method: "PUT",
        url: `/api/servers/${defaultServerId}/members/${mod.user.id}/roles/${roleId}`,
        cookies: owner.cookies
      });
    }
    assert.equal((await update(mod, helpers.id, { permissions: ["manageServer"] })).statusCode, 403);
    assert.equal((await update(mod, seeded("everyone"), { permissions: ["manageInvites"] })).statusCode, 403);
    // What they hold they may hand down, and anything may be switched off.
    assert.equal((await update(mod, helpers.id, { permissions: ["createInvites"] })).statusCode, 200);
    assert.equal((await update(mod, helpers.id, { permissions: [] })).statusCode, 200);
  });

  it("keeps a Role carrying Administrator the owner's alone, so an Admin cannot make an Admin 2", async () => {
    const deputies = (await create(owner, "Deputies")).json().role as RoleSummary;
    assert.equal((await update(owner, deputies.id, { permissions: ["administrator"] })).statusCode, 200);
    const given = await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${plain.user.id}/roles/${deputies.id}`,
      cookies: admin.cookies
    });
    assert.equal(given.statusCode, 403);
    assert.equal((await update(admin, deputies.id, { name: "Mine" })).statusCode, 403);
    assert.equal((await remove(admin, deputies.id)).statusCode, 403);
    const byOwner = await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${plain.user.id}/roles/${deputies.id}`,
      cookies: owner.cookies
    });
    assert.equal(byOwner.statusCode, 200);
  });

  it("writes nothing for a change that changes nothing", async () => {
    const helpers = (await create(owner, "Helpers")).json().role as RoleSummary;
    assert.equal((await update(owner, helpers.id, { name: "Helpers" })).statusCode, 200);
    assert.equal((await update(owner, helpers.id, {})).statusCode, 200);
    assert.equal(all(app.sqlite, "select 1 from audit_events where action = 'role.updated'").length, 0);
  });

  it("lets the owner do everything, Administrator on any Role included", async () => {
    const helpers = (await create(owner, "Helpers")).json().role as RoleSummary;
    assert.equal((await update(owner, helpers.id, { permissions: ["administrator"] })).statusCode, 200);
    assert.equal((await update(owner, seeded("admin"), { name: "Captains", color: "#d93f3f" })).statusCode, 200);
    // Admin holds Administrator always; switching it off on another Role sticks.
    assert.equal((await update(owner, seeded("admin"), { permissions: [] })).statusCode, 400);
    assert.equal((await update(owner, helpers.id, { permissions: [] })).statusCode, 200);
    const holder = await acceptInvite("Holder");
    await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${holder.user.id}/roles/${helpers.id}`,
      cookies: owner.cookies
    });
    assert.deepEqual(
      (await app.server.inject({ method: "GET", url: base, cookies: holder.cookies })).json().permissions,
      []
    );
  });

  it("refuses a colour outside the palette, a name for @everyone, and an unknown Permission", async () => {
    const helpers = (await create(owner, "Helpers")).json().role as RoleSummary;
    assert.equal((await update(owner, helpers.id, { color: "#123456" })).statusCode, 400);
    assert.equal((await update(owner, helpers.id, { permissions: ["sudo"] })).statusCode, 400);
    assert.equal((await update(owner, seeded("everyone"), { name: "All" })).statusCode, 400);
    assert.equal((await update(owner, helpers.id, { color: null })).statusCode, 200);
  });

  it("reorders the movable Roles, keeping Admin first and @everyone last, and an Admin only below them", async () => {
    const one = (await create(owner, "One")).json().role as RoleSummary;
    const two = (await create(owner, "Two")).json().role as RoleSummary;
    const recruiter = seeded("recruiter");
    // Current order, top first: Admin, Recruiter, One, Two, @everyone.
    assert.deepEqual(
      roles().map((row) => row.id),
      [seeded("admin"), recruiter, one.id, two.id, seeded("everyone")]
    );
    const moved = await reorder(admin, [two.id, recruiter, one.id]);
    assert.equal(moved.statusCode, 200);
    assert.deepEqual(
      roles().map((row) => row.id),
      [seeded("admin"), two.id, recruiter, one.id, seeded("everyone")]
    );
    // The same order again writes nothing.
    const before = all(app.sqlite, "select 1 from audit_events where action = 'role.reordered'").length;
    assert.equal((await reorder(owner, [two.id, recruiter, one.id])).statusCode, 200);
    assert.equal(all(app.sqlite, "select 1 from audit_events where action = 'role.reordered'").length, before);
    // Fixed Roles cannot be listed or moved; every movable Role must be named once.
    assert.equal((await reorder(owner, [seeded("admin"), two.id, recruiter, one.id])).statusCode, 400);
    assert.equal((await reorder(owner, [two.id, recruiter])).statusCode, 400);
    assert.equal((await reorder(plain, [one.id, two.id, recruiter])).statusCode, 403);

    // Someone holding Manage roles through Recruiter may not move it, or move anything above it.
    await update(owner, recruiter, { permissions: ["createInvites", "manageRoles"] });
    const mover = await acceptInvite("Mover");
    await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${mover.user.id}/roles/${recruiter}`,
      cookies: owner.cookies
    });
    assert.equal((await reorder(mover, [recruiter, two.id, one.id])).statusCode, 403);
    assert.equal((await reorder(mover, [two.id, recruiter, one.id])).statusCode, 200);
  });

  it("deletes a Role from its members, never Admin or @everyone, and only below an Admin", async () => {
    const helpers = (await create(owner, "Helpers")).json().role as RoleSummary;
    await update(owner, helpers.id, { permissions: ["createInvites"] });
    await app.server.inject({
      method: "PUT",
      url: `/api/servers/${defaultServerId}/members/${plain.user.id}/roles/${helpers.id}`,
      cookies: owner.cookies
    });
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${defaultServerId}/invites`,
      cookies: plain.cookies,
      payload: { label: "Friends", expiresInMinutes: 1440 }
    });
    assert.equal(invite.statusCode, 201);

    assert.equal((await remove(admin, seeded("admin"))).statusCode, 403);
    assert.equal((await remove(owner, seeded("admin"))).statusCode, 409);
    assert.equal((await remove(owner, seeded("everyone"))).statusCode, 409);
    assert.equal((await remove(plain, helpers.id)).statusCode, 403);
    assert.equal((await remove(admin, helpers.id)).statusCode, 204);
    assert.equal(
      one<{ count: number }>(app.sqlite, "select count(*) as count from member_roles where role_id = ?", [helpers.id])
        ?.count,
      0
    );
    // Losing Create invites with the Role takes the member's links with it.
    assert.notEqual(
      one<{ revoked_at: string | null }>(app.sqlite, "select revoked_at from invites where id = ?", [
        invite.json().invite.id
      ])?.revoked_at,
      null
    );
    assert.deepEqual(
      roles().map((row) => row.position),
      [2, 1, 0]
    );
    const audits = all<{ action: string }>(
      app.sqlite,
      "select action from audit_events where action in ('role.created', 'role.updated', 'role.deleted') order by created_at"
    ).map((row) => row.action);
    assert.deepEqual(audits, ["role.created", "role.updated", "role.deleted"]);
  });

  it("lets every member invite at once when @everyone gains Create invites", async () => {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createClient(baseUrl, {
        transports: ["websocket"],
        extraHeaders: { cookie: `voxly_session=${sessionToken(plain.cookies)}` },
        reconnection: false
      });
      candidate.once("connect", () => resolve(candidate));
      candidate.once("connect_error", (error) => reject(error));
    });
    sockets.push(socket);
    await waitFor(() => app.io.sockets.sockets.get(socket.id!)?.rooms.has(`server:${defaultServerId}`) ?? false);
    const changed = new Promise<{ serverId: string }>((resolve) => socket.once("server:rolesChanged", resolve));
    assert.equal((await update(owner, seeded("everyone"), { permissions: ["createInvites"] })).statusCode, 200);
    assert.deepEqual(await changed, { serverId: defaultServerId });
    const mine = await app.server.inject({ method: "GET", url: base, cookies: plain.cookies });
    assert.deepEqual(mine.json().permissions, ["createInvites"]);
  });
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
