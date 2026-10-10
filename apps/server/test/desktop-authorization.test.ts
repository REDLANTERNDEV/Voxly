import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

const origin = "https://voxly.example.com";
const desktopAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("browser approval for a desktop Device", () => {
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

  async function owner() {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
    });
    assert.equal(response.statusCode, 201);
    return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
  }

  async function create() {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/devices/desktop-authorizations",
      headers: { origin, "user-agent": desktopAgent }
    });
    assert.equal(response.statusCode, 201);
    return response.json() as { id: string; secret: string; confirmation: string };
  }

  function decision(id: string, cookies: Record<string, string>, approve: boolean, requestOrigin = origin) {
    return app.server.inject({
      method: "POST",
      url: `/api/devices/desktop-authorizations/${id}/decision`,
      headers: { origin: requestOrigin },
      cookies,
      payload: { approve }
    });
  }

  function collect(id: string, secret: string, requestOrigin = origin) {
    return app.server.inject({
      method: "POST",
      url: `/api/devices/desktop-authorizations/${id}/collect`,
      headers: { origin: requestOrigin, "user-agent": desktopAgent },
      payload: { secret }
    });
  }

  it("requires explicit browser approval and sets the new Device cookie only on collection", async () => {
    const cookies = await owner();
    const request = await create();
    const preview = await app.server.inject({
      method: "GET",
      url: `/api/devices/desktop-authorizations/${request.id}`,
      cookies
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().confirmation, request.confirmation);
    assert.equal(preview.json().origin, origin);
    assert.equal(preview.json().label, "Chrome on Windows");

    const pending = await collect(request.id, request.secret);
    assert.equal(pending.json().status, "pending");
    assert.equal(pending.cookies.length, 0);

    const approved = await decision(request.id, cookies, true);
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.cookies.length, 0);
    assert.equal(
      (
        app.sqlite.prepare("select count(*) as count from audit_events where action = 'device.linked'").get() as {
          count: number;
        }
      ).count,
      0
    );
    const collected = await collect(request.id, request.secret);
    assert.equal(collected.json().status, "approved");
    const desktopCookies = Object.fromEntries(collected.cookies.map((cookie) => [cookie.name, cookie.value]));
    assert.ok(desktopCookies.voxly_session);
    assert.notEqual(desktopCookies.voxly_session, cookies.voxly_session);
    assert.equal((await app.server.inject({ method: "GET", url: "/api/me", cookies })).statusCode, 200);
    assert.equal((await app.server.inject({ method: "GET", url: "/api/me", cookies: desktopCookies })).statusCode, 200);
    assert.equal((await collect(request.id, request.secret)).json().status, "expired");
    assert.equal(
      (
        app.sqlite.prepare("select count(*) as count from audit_events where action = 'device.linked'").get() as {
          count: number;
        }
      ).count,
      1
    );
  });

  it("does not let a public id, wrong secret, or another origin collect a session", async () => {
    const cookies = await owner();
    const request = await create();
    assert.equal((await collect(request.id, request.id)).statusCode, 404);
    assert.equal((await decision(request.id, cookies, true, "https://other.example.com")).statusCode, 404);
    assert.equal((await collect(request.id, request.secret, "https://other.example.com")).statusCode, 404);
    assert.equal((await decision(request.id, cookies, true)).statusCode, 200);
    assert.equal((await collect(request.id, "x".repeat(43))).statusCode, 404);
    assert.equal((await collect(request.id, request.secret)).json().status, "approved");
  });

  it("requires a supported initiating origin", async () => {
    for (const headers of [{}, { origin: "http://example.com" }, { origin: "null" }]) {
      const response = await app.server.inject({ method: "POST", url: "/api/devices/desktop-authorizations", headers });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/devices/desktop-authorizations",
          headers: { origin: "http://127.0.0.1:5173" }
        })
      ).statusCode,
      201
    );
  });

  it("keeps refusal, cancellation, expiry, and replay terminal", async () => {
    const cookies = await owner();
    const refused = await create();
    assert.equal((await decision(refused.id, cookies, false)).statusCode, 200);
    assert.equal((await collect(refused.id, refused.secret)).json().status, "refused");
    assert.equal((await decision(refused.id, cookies, true)).statusCode, 404);

    const cancelled = await create();
    const cancel = await app.server.inject({
      method: "POST",
      url: `/api/devices/desktop-authorizations/${cancelled.id}/cancel`,
      headers: { origin },
      payload: { secret: cancelled.secret }
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal((await collect(cancelled.id, cancelled.secret)).json().status, "expired");
    assert.equal((await decision(cancelled.id, cookies, true)).statusCode, 404);

    const expired = await create();
    app.sqlite
      .prepare("update desktop_authorizations set expires_at = ? where id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.id);
    assert.equal((await collect(expired.id, expired.secret)).json().status, "expired");
    assert.equal((await decision(expired.id, cookies, true)).statusCode, 404);
  });

  it("rejects collection if the approving browser session is revoked", async () => {
    const cookies = await owner();
    const request = await create();
    await decision(request.id, cookies, true);
    app.sqlite
      .prepare(
        "update sessions set revoked_at = ? where id = (select approved_session_id from desktop_authorizations where id = ?)"
      )
      .run(new Date().toISOString(), request.id);
    const result = await collect(request.id, request.secret);
    assert.equal(result.json().status, "expired");
    assert.equal(result.cookies.length, 0);
  });
  async function launch(cookies: Record<string, string>) {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/devices/desktop-launches",
      headers: { origin },
      cookies
    });
    assert.equal(response.statusCode, 201);
    return response.json() as { id: string; account: string };
  }

  async function arrive(id: string, requestOrigin = origin) {
    return app.server.inject({
      method: "POST",
      url: "/api/devices/desktop-authorizations",
      headers: { origin: requestOrigin, "user-agent": desktopAgent },
      payload: { launchId: id }
    });
  }

  it("joins browser launch to a private desktop request without authorizing the public id", async () => {
    const cookies = await owner();
    const opened = await launch(cookies);
    assert.equal(opened.account, "Owner");
    assert.deepEqual(Object.keys(opened).sort(), ["account", "id"]);
    const before = await app.server.inject({
      method: "GET",
      url: `/api/devices/desktop-launches/${opened.id}`,
      cookies
    });
    assert.equal(before.json().authorizationId, null);
    assert.equal((await arrive(opened.id, "https://other.example")).statusCode, 404);
    const arrived = await arrive(opened.id);
    assert.equal(arrived.statusCode, 201);
    const request = arrived.json() as { id: string; secret: string; confirmation: string };
    assert.equal((await arrive(opened.id)).statusCode, 404);
    const waiting = await app.server.inject({
      method: "GET",
      url: `/api/devices/desktop-launches/${opened.id}`,
      cookies
    });
    assert.deepEqual(waiting.json(), { authorizationId: request.id });
    assert.equal((await collect(request.id, opened.id)).statusCode, 404);
    assert.equal((await collect(request.id, request.secret)).json().status, "pending");
    assert.equal((await decision(request.id, cookies, true)).statusCode, 200);
    assert.equal((await collect(request.id, request.secret)).json().status, "approved");
    assert.equal((await collect(request.id, request.secret)).json().status, "expired");
    const stored = app.sqlite
      .prepare("select secret_hash from desktop_authorizations where id = ?")
      .get(request.id) as { secret_hash: string };
    assert.notEqual(stored.secret_hash, request.secret);
  });

  it("binds launch lookup and approval to the originating browser Device", async () => {
    const cookies = await owner();
    const opened = await launch(cookies);
    const request = (await arrive(opened.id)).json() as { id: string; secret: string };
    // The manually approved flow gives the same Account another Device.
    const other = await create();
    await decision(other.id, cookies, true);
    const collected = await collect(other.id, other.secret);
    const otherCookies = Object.fromEntries(collected.cookies.map((cookie) => [cookie.name, cookie.value]));
    assert.equal(
      (
        await app.server.inject({
          method: "GET",
          url: `/api/devices/desktop-launches/${opened.id}`,
          cookies: otherCookies
        })
      ).statusCode,
      404
    );
    assert.equal((await decision(request.id, otherCookies, true)).statusCode, 404);
    assert.equal((await decision(request.id, cookies, true)).statusCode, 200);
  });

  it("cancels and expires launches without minting a Device and refuses revoked initiating sessions", async () => {
    const cookies = await owner();
    const opened = await launch(cookies);
    const request = (await arrive(opened.id)).json() as { id: string; secret: string };
    const cancel = await app.server.inject({
      method: "POST",
      url: `/api/devices/desktop-launches/${opened.id}/cancel`,
      headers: { origin },
      cookies
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal((await decision(request.id, cookies, true)).statusCode, 404);
    assert.equal((await collect(request.id, request.secret)).json().status, "expired");
    const expired = await launch(cookies);
    app.sqlite
      .prepare("update desktop_launches set expires_at = ? where id = ?")
      .run("2000-01-01T00:00:00.000Z", expired.id);
    assert.equal((await arrive(expired.id)).statusCode, 404);
    const revoked = await launch(cookies);
    app.sqlite
      .prepare("update sessions set revoked_at = ? where id = (select session_id from desktop_launches where id = ?)")
      .run(new Date().toISOString(), revoked.id);
    assert.equal((await arrive(revoked.id)).statusCode, 404);
  });
});
