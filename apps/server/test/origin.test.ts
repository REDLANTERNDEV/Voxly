import { cookieJar, sessionToken } from "./sessionCookies.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

/**
 * SameSite=Lax keeps a cross-site page from riding the session, but not a page
 * on a sibling subdomain: that is still same-site. These hold the line where
 * the browser cannot — writes, the realtime handshake, and the unprotected
 * cookie name — against an Origin that is not the installation's own. Callers
 * without an Origin (the Music bot, CLIs) are not browsers and are let through.
 */
describe("the installation's own origin", () => {
  let app: VoxlyApp | undefined;
  let sockets: Socket[] = [];

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    sockets = [];
    await app?.close();
    app = undefined;
  });

  async function start(options: { publicUrl?: string; secureCookies?: boolean } = {}) {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: options.secureCookies ?? false,
      publicUrl: "publicUrl" in options ? options.publicUrl : "https://voxly.example.com"
    });
    const owner = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
    });
    assert.equal(owner.statusCode, 201);
    return { app, cookies: cookieJar(owner) };
  }

  function logout(server: VoxlyApp, cookies: Record<string, string>, origin?: string) {
    return server.server.inject({
      method: "POST",
      url: "/api/logout",
      cookies,
      headers: origin ? { origin } : {}
    });
  }

  it("refuses a write from another origin, and allows its own or none", async () => {
    const { app: server, cookies } = await start();

    const foreign = await logout(server, cookies, "https://chat-evil.example.com");
    assert.equal(foreign.statusCode, 403);
    assert.deepEqual(foreign.json(), { error: "forbidden" });
    // The session the forged request tried to end is still there.
    assert.equal(
      (await server.server.inject({ method: "GET", url: "/api/me", cookies })).statusCode,
      200,
      "a refused write changes nothing"
    );

    assert.notEqual((await logout(server, cookies, "https://voxly.example.com")).statusCode, 403);
  });

  it("lets reads through and lets a write without an Origin through", async () => {
    const { app: server, cookies } = await start();
    const read = await server.server.inject({
      method: "GET",
      url: "/api/me",
      cookies,
      headers: { origin: "https://chat-evil.example.com" }
    });
    assert.equal(read.statusCode, 200);
    assert.notEqual((await logout(server, cookies)).statusCode, 403);
  });

  it("enforces nothing when the installation has not said what its origin is", async () => {
    const { app: server, cookies } = await start({ publicUrl: undefined });
    assert.notEqual((await logout(server, cookies, "https://chat-evil.example.com")).statusCode, 403);
  });

  it("refuses a realtime handshake from another origin", async () => {
    const { app: server, cookies } = await start();
    await server.server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(server.server.server.address() as { port: number }).port}`;
    const token = sessionToken(cookies);
    const connect = (origin?: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = createClient(baseUrl, {
          transports: ["websocket"],
          reconnection: false,
          extraHeaders: { cookie: `voxly_session=${token}`, ...(origin ? { origin } : {}) }
        });
        sockets.push(socket);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", (error) => reject(new Error(`connect_error: ${error.message}`)));
      });

    await assert.rejects(connect("https://chat-evil.example.com"), /connect_error/);
    assert.ok((await connect("https://voxly.example.com")).connected);
    // The Music bot is a Node client and sends no Origin at all.
    assert.ok((await connect()).connected);
  });

  it("over HTTPS, reads the unprotected cookie name only from a caller that is not a browser", async () => {
    const { app: server, cookies } = await start({ secureCookies: true });
    // A sibling subdomain can set `voxly_session` for the parent domain; only
    // the `__Host-` name is out of its reach.
    const planted = { voxly_session: sessionToken(cookies) };

    const fromBrowser = await server.server.inject({
      method: "GET",
      url: "/api/me",
      cookies: planted,
      headers: { "sec-fetch-site": "same-origin" }
    });
    assert.equal(fromBrowser.statusCode, 401);
    const withOrigin = await server.server.inject({
      method: "GET",
      url: "/api/me",
      cookies: planted,
      headers: { origin: "https://voxly.example.com" }
    });
    assert.equal(withOrigin.statusCode, 401);

    // The Music bot is told this name and sends it from Node, with no Origin.
    assert.equal((await server.server.inject({ method: "GET", url: "/api/me", cookies: planted })).statusCode, 200);
    // The protected name keeps working from a browser.
    assert.equal(
      (
        await server.server.inject({
          method: "GET",
          url: "/api/me",
          cookies,
          headers: { origin: "https://voxly.example.com", "sec-fetch-site": "same-origin" }
        })
      ).statusCode,
      200
    );
  });
});
