import { cookieJar } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AuditLogPage } from "@voxly/shared";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { audit } from "../src/audit.js";
import type { VoxlyDatabase } from "../src/db/database.js";

type Identity = { user: { id: string }; cookies: Record<string, string> };
const server = "the-basement";

describe("a Server's Audit log (ADR-0039)", () => {
  let app: VoxlyApp;
  let owner: Identity;
  let reader: Identity;
  let member: Identity;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "audit-fixture",
      allowHttpOwnerBootstrap: true,
      secureCookies: false
    });
    const bootstrap = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "audit-fixture", nickname: "Owner" }
    });
    owner = { user: bootstrap.json().user, cookies: cookieJar(bootstrap) };
    reader = await join("Reader");
    member = await join("Member");
    // A Role carrying View audit log, given to the reader.
    const role = await send(owner, "POST", `/api/servers/${server}/roles`, { name: "Auditors" });
    const roleId = role.json().role.id as string;
    await send(owner, "PATCH", `/api/servers/${server}/roles/${roleId}`, { permissions: ["viewAuditLog"] });
    await send(owner, "PUT", `/api/servers/${server}/members/${reader.user.id}/roles/${roleId}`);
  });

  afterEach(async () => {
    await app.close();
  });

  function send(who: Identity, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) {
    return app.server.inject({ method, url, cookies: who.cookies, ...(payload ? { payload } : {}) });
  }

  async function join(nickname: string): Promise<Identity> {
    const invite = await send(owner, "POST", "/api/owner/invites", { label: nickname });
    const accepted = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: invite.json().invite.token, nickname }
    });
    return { user: accepted.json().user, cookies: cookieJar(accepted) };
  }

  async function log(who: Identity, query = "") {
    const response = await send(who, "GET", `/api/servers/${server}/audit-log${query}`);
    return { status: response.statusCode, page: response.json() as AuditLogPage };
  }

  it("is read only with View audit log", async () => {
    assert.equal((await log(member)).status, 403);
    assert.equal((await log(reader)).status, 200);
    assert.equal((await log(owner)).status, 200);
  });

  it("names what each change touched, newest first", async () => {
    const created = await send(owner, "POST", `/api/servers/${server}/rooms`, { name: "announcements", kind: "text" });
    const roomId = created.json().room.id as string;
    await send(owner, "PATCH", `/api/servers/${server}/rooms/${roomId}`, { name: "news" });
    await send(owner, "DELETE", `/api/servers/${server}/rooms/${roomId}`);

    const { page } = await log(reader);
    const [deleted, renamed, made] = page.entries;
    assert.equal(deleted?.action, "room.deleted");
    assert.equal(deleted?.details.room, "news");
    assert.equal(renamed?.action, "room.renamed");
    assert.equal(renamed?.details.previousRoom, "announcements");
    assert.equal(made?.action, "room.created");
    assert.equal(made?.actor?.nickname, "Owner");
    assert.equal(page.entries.find((entry) => entry.action === "role.given")?.target?.nickname, "Reader");
  });

  it("leaves out an Account's own business", async () => {
    // `audit` reads only the connection.
    const database = { sqlite: app.sqlite } as VoxlyDatabase;
    audit(database, owner.user.id, "device.linked", owner.user.id, server);
    audit(database, owner.user.id, "access_link.created", member.user.id, server);
    const actions = (await log(owner)).page.entries.map((entry) => entry.action);
    assert.ok(!actions.includes("device.linked" as never));
    assert.ok(!actions.includes("access_link.created" as never));
  });

  it("withholds a Hidden channel's name from someone who cannot see it", async () => {
    await send(owner, "POST", `/api/servers/${server}/rooms`, {
      name: "staff",
      kind: "text",
      access: { isPrivate: true, listed: false, userIds: [], roleIds: [] }
    });
    const seen = (await log(owner)).page.entries.find((entry) => entry.action === "room.created");
    assert.equal(seen?.details.room, "staff");
    const hidden = (await log(reader)).page.entries.find((entry) => entry.action === "room.created");
    assert.equal(hidden?.details.room, undefined);
    assert.equal(hidden?.details.roomHidden, true);
    assert.equal(hidden?.details.roomPrivate, undefined);
  });

  it("keeps who created an Invite to the owner, as the Invite trail does (ADR-0034)", async () => {
    await send(owner, "POST", `/api/servers/${server}/invites`, { label: "Friends", expiresInMinutes: 60 });
    const forOwner = (await log(owner)).page.entries.find((entry) => entry.action === "invite.created");
    const forReader = (await log(reader)).page.entries.find((entry) => entry.action === "invite.created");
    assert.equal(forOwner?.actor?.nickname, "Owner");
    assert.equal(forReader?.actor, null);
    assert.equal(forReader?.details.name, "Friends");
  });

  it("logs a moderator deleting someone else's message, but not their own", async () => {
    const rooms = await send(owner, "GET", `/api/servers/${server}/rooms`);
    const listed = rooms.json() as { rooms: Array<{ id: string; name: string }> };
    const general = listed.rooms.find((room) => room.name === "general")!;
    const post = async (who: Identity) =>
      (
        await send(who, "POST", `/api/rooms/${general.id}/messages`, { body: "hi", clientId: crypto.randomUUID() })
      ).json().message.id as string;
    const theirs = await post(member);
    const own = await post(owner);
    await send(owner, "DELETE", `/api/rooms/${general.id}/messages/${theirs}`);
    await send(owner, "DELETE", `/api/rooms/${general.id}/messages/${own}`);
    const deletions = (await log(owner, "?action=message.deleted")).page.entries;
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0]?.target?.nickname, "Member");
    assert.equal(deletions[0]?.details.room, "general");
  });

  it("pages back without skipping or repeating a line", async () => {
    for (let index = 0; index < 60; index += 1)
      await send(owner, "POST", `/api/servers/${server}/categories`, { name: `c${index}` });
    const first = (await log(owner)).page;
    assert.equal(first.entries.length, 50);
    assert.ok(first.nextBefore);
    const second = (await log(owner, `?before=${encodeURIComponent(first.nextBefore)}`)).page;
    const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    const names = [...first.entries, ...second.entries]
      .filter((entry) => entry.action === "category.created")
      .map((entry) => entry.details.name);
    assert.deepEqual(
      names,
      Array.from({ length: 60 }, (_, index) => `c${59 - index}`)
    );
  });

  it("filters by who acted", async () => {
    const { page } = await log(owner, `?actorId=${encodeURIComponent(reader.user.id)}`);
    assert.deepEqual(page.entries, []);
  });
});
