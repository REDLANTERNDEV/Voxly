import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { createOwnerClaim, createOwnerLoginClaim } from "../src/auth/ownerClaims.js";
import { one, run } from "../src/db/database.js";

describe("Voxly HTTP MVP", () => {
  let app: VoxlyApp;

  beforeEach(async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false,
      publicUrl: "https://voxly.example.com"
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("bootstraps the first owner and sets a session cookie", async () => {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/bootstrap/owner",
      payload: { bootstrapToken: "bootstrap-secret", nickname: "Red Lantern" }
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.cookies[0]?.name, "voxly_session");
    assert.equal(response.cookies[0]?.httpOnly, true);
    assert.equal(response.cookies[0]?.sameSite, "Lax");

    const body = response.json();
    assert.equal(body.user.nickname, "Red Lantern");
    assert.equal(body.user.role, "owner");
  });

  it("keeps HTTP owner bootstrap disabled unless explicitly enabled", async () => {
    const lockedApp = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      secureCookies: false
    });

    try {
      const response = await lockedApp.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "bootstrap-secret", nickname: "Red Lantern" }
      });

      assert.equal(response.statusCode, 404);
      const tables = lockedApp.dumpTables() as { users: unknown[] };
      assert.equal(tables.users.length, 0);
    } finally {
      await lockedApp.close();
    }
  });

  it("exchanges a shell-created owner claim once without storing the raw token", async () => {
    await app.close();
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-owner-claim-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const claim = await createOwnerClaim({
      databasePath,
      nickname: "Red Lantern",
      baseUrl: "http://127.0.0.1:3000"
    });
    app = await createVoxlyApp({
      databasePath,
      secureCookies: false
    });

    try {
      assert.equal(claim.url.includes(claim.token), true);
      assert.equal(JSON.stringify(app.dumpTables()).includes(claim.token), false);

      const response = await app.server.inject({
        method: "POST",
        url: "/api/setup/owner/claim",
        payload: { claimToken: claim.token }
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.cookies[0]?.name, "voxly_session");
      assert.equal(response.json().user.role, "owner");

      const reuseResponse = await app.server.inject({
        method: "POST",
        url: "/api/setup/owner/claim",
        payload: { claimToken: claim.token }
      });
      assert.equal(reuseResponse.statusCode, 404);
    } finally {
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("sees owner claims created while the app process is already running", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-live-owner-claim-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const liveApp = await createVoxlyApp({
      databasePath,
      secureCookies: false
    });

    try {
      const claim = await createOwnerClaim({
        databasePath,
        nickname: "Red Lantern",
        baseUrl: "http://127.0.0.1:3000"
      });

      const response = await liveApp.server.inject({
        method: "POST",
        url: "/api/setup/owner/claim",
        payload: { claimToken: claim.token }
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.json().user.role, "owner");
    } finally {
      await liveApp.close();
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("rejects expired owner claim tokens", async () => {
    await app.close();
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-expired-owner-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const claim = await createOwnerClaim({
      databasePath,
      nickname: "Red Lantern",
      baseUrl: "http://127.0.0.1:3000",
      expiresInMinutes: -1
    });
    app = await createVoxlyApp({
      databasePath,
      secureCookies: false
    });

    try {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/setup/owner/claim",
        payload: { claimToken: claim.token }
      });

      assert.equal(response.statusCode, 404);
      assert.equal(response.cookies.length, 0);
    } finally {
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("creates a shell-only login claim for an existing owner without adding another owner", async () => {
    await app.close();
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-owner-login-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const firstClaim = await createOwnerClaim({
      databasePath,
      nickname: "Red Lantern",
      baseUrl: "http://127.0.0.1:3000"
    });
    const loginClaim = await createOwnerLoginClaim({
      databasePath,
      baseUrl: "http://127.0.0.1:3000"
    });
    app = await createVoxlyApp({
      databasePath,
      secureCookies: false
    });

    try {
      assert.notEqual(loginClaim.token, firstClaim.token);
      assert.equal(loginClaim.user.id, firstClaim.user.id);

      const response = await app.server.inject({
        method: "POST",
        url: "/api/setup/owner/claim",
        payload: { claimToken: loginClaim.token }
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.json().user.nickname, "Red Lantern");

      const tables = app.dumpTables() as { users: Array<{ role: string }> };
      assert.equal(tables.users.filter((user) => user.role === "owner").length, 1);
    } finally {
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("stores invite and session tokens only as hashes", async () => {
    const owner = await bootstrapOwner(app);

    const inviteResponse = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { label: "Mert invite" }
    });
    assert.equal(inviteResponse.statusCode, 201);

    const inviteToken = inviteResponse.json().invite.token as string;
    const tablesAfterInvite = app.dumpTables() as { invites: Array<{ token_hash: string }> };
    assert.ok(tablesAfterInvite.invites.some((invite) => invite.token_hash === hashToken(inviteToken)));
    assert.equal(JSON.stringify(tablesAfterInvite).includes(inviteToken), false);

    const acceptResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken, nickname: "Mert" }
    });
    assert.equal(acceptResponse.statusCode, 201);

    const sessionCookie = acceptResponse.cookies.find(
      (cookie: { name: string; value: string }) => cookie.name === "voxly_session"
    );
    assert.equal(typeof sessionCookie?.value, "string");
    assert.equal(JSON.stringify(app.dumpTables()).includes(sessionCookie?.value ?? ""), false);
  });

  it("refreshes active session expiry on authenticated requests", async () => {
    const owner = await bootstrapOwner(app);
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    run(app.sqlite, "update sessions set expires_at = ? where token_hash = ?", [
      soon,
      hashToken(owner.cookies.voxly_session)
    ]);

    const firstResponse = await app.server.inject({
      method: "GET",
      url: "/api/me",
      cookies: owner.cookies
    });
    assert.equal(firstResponse.statusCode, 200);

    const sessionCookie = firstResponse.cookies.find(
      (cookie: { name: string }) => cookie.name === "voxly_session"
    );
    assert.equal(sessionCookie?.name, "voxly_session");
    assert.ok(sessionCookie?.expires instanceof Date);

    const session = one<{ expires_at: string }>(
      app.sqlite,
      "select expires_at from sessions where token_hash = ?",
      [hashToken(owner.cookies.voxly_session)]
    );
    assert.ok(session);
    assert.ok(new Date(session.expires_at).getTime() > new Date(soon).getTime());
  });

  it("blocks banned users even when they still have a session cookie", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");

    const banResponse = await app.server.inject({
      method: "POST",
      url: `/api/owner/users/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(banResponse.statusCode, 204);

    const meResponse = await app.server.inject({
      method: "GET",
      url: "/api/me",
      cookies: member.cookies
    });
    assert.equal(meResponse.statusCode, 401);
  });

  it("lets owners inspect users, invites, sessions and revoke a session", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Selin");

    const usersResponse = await app.server.inject({
      method: "GET",
      url: "/api/owner/users",
      cookies: owner.cookies
    });
    assert.equal(usersResponse.statusCode, 200);
    assert.ok(usersResponse.json().users.some((user: { nickname: string }) => user.nickname === "Selin"));

    const invitesResponse = await app.server.inject({
      method: "GET",
      url: "/api/owner/invites",
      cookies: owner.cookies
    });
    assert.equal(invitesResponse.statusCode, 200);
    assert.equal(JSON.stringify(invitesResponse.json()).includes("token"), false);
    assert.ok(invitesResponse.json().invites.every((invite: { label: string }) => typeof invite.label === "string"));

    const sessionsResponse = await app.server.inject({
      method: "GET",
      url: "/api/owner/sessions",
      cookies: owner.cookies
    });
    assert.equal(sessionsResponse.statusCode, 200);
    const memberSession = sessionsResponse
      .json()
      .sessions.find((session: { userId: string }) => session.userId === member.user.id);
    assert.ok(memberSession);

    const revokeResponse = await app.server.inject({
      method: "POST",
      url: `/api/owner/sessions/${memberSession.id}/revoke`,
      cookies: owner.cookies
    });
    assert.equal(revokeResponse.statusCode, 204);

    const meResponse = await app.server.inject({
      method: "GET",
      url: "/api/me",
      cookies: member.cookies
    });
    assert.equal(meResponse.statusCode, 401);
  });

  it("lets owners create expiring invites and revoke them before use", async () => {
    const owner = await bootstrapOwner(app);

    const createResponse = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { expiresInHours: 2, label: "Jules" }
    });
    assert.equal(createResponse.statusCode, 201);
    assert.equal(createResponse.json().invite.label, "Jules");
    assert.equal(typeof createResponse.json().invite.expiresAt, "string");
    const inviteId = createResponse.json().invite.id;
    const inviteToken = createResponse.json().invite.token;

    const revokeResponse = await app.server.inject({
      method: "POST",
      url: `/api/owner/invites/${inviteId}/revoke`,
      cookies: owner.cookies
    });
    assert.equal(revokeResponse.statusCode, 204);

    const invitesResponse = await app.server.inject({
      method: "GET",
      url: "/api/owner/invites",
      cookies: owner.cookies
    });
    const invite = invitesResponse.json().invites.find((item: { id: string }) => item.id === inviteId);
    assert.equal(typeof invite.revokedAt, "string");
    assert.equal(JSON.stringify(invitesResponse.json()).includes(inviteToken), false);

    const acceptResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken, nickname: "Jules" }
    });
    assert.equal(acceptResponse.statusCode, 404);
  });

  it("returns public config for invite URL and WebRTC setup", async () => {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/config"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().publicUrl, "https://voxly.example.com");
    assert.deepEqual(response.json().rtc.iceServers, []);
    assert.equal(response.json().turnstile, null);
  });

  it("publishes only the public Turnstile site key", async () => {
    const turnstileApp = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: false,
      turnstile: { enabled: true, siteKey: "0x4AAAA-site-key", secretKey: "private-secret" }
    });

    try {
      const response = await turnstileApp.server.inject({ method: "GET", url: "/api/config" });
      assert.deepEqual(response.json().turnstile, { siteKey: "0x4AAAA-site-key" });
      assert.equal(response.body.includes("private-secret"), false);
    } finally {
      await turnstileApp.close();
    }
  });

  it("requires invite labels and reports revoke conflicts", async () => {
    const owner = await bootstrapOwner(app);

    const missingLabel = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { expiresInHours: 2 }
    });
    assert.equal(missingLabel.statusCode, 400);

    const inviteResponse = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites",
      cookies: owner.cookies,
      payload: { label: "Ada" }
    });
    assert.equal(inviteResponse.statusCode, 201);

    const inviteId = inviteResponse.json().invite.id;
    const inviteToken = inviteResponse.json().invite.token;
    const memberResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken, nickname: "Ada" }
    });
    assert.equal(memberResponse.statusCode, 201);

    const usedRevoke = await app.server.inject({
      method: "POST",
      url: `/api/owner/invites/${inviteId}/revoke`,
      cookies: owner.cookies
    });
    assert.equal(usedRevoke.statusCode, 409);

    const missingRevoke = await app.server.inject({
      method: "POST",
      url: "/api/owner/invites/00000000-0000-4000-8000-000000000000/revoke",
      cookies: owner.cookies
    });
    assert.equal(missingRevoke.statusCode, 404);
  });

  it("persists text messages in text rooms only", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");

    const roomsResponse = await app.server.inject({
      method: "GET",
      url: "/api/rooms",
      cookies: member.cookies
    });
    assert.equal(roomsResponse.statusCode, 200);
    const rooms = roomsResponse.json().rooms as Array<{ id: string; kind: string }>;
    const textRoom = rooms.find((room) => room.kind === "text");
    const voiceRoom = rooms.find((room) => room.kind === "voice");

    const messageResponse = await app.server.inject({
      method: "POST",
      url: `/api/rooms/${textRoom?.id}/messages`,
      cookies: member.cookies,
      payload: { body: "oyuna giriyorum" }
    });
    assert.equal(messageResponse.statusCode, 201);

    const voiceMessageResponse = await app.server.inject({
      method: "POST",
      url: `/api/rooms/${voiceRoom?.id}/messages`,
      cookies: member.cookies,
      payload: { body: "olmamalı" }
    });
    assert.equal(voiceMessageResponse.statusCode, 400);

    const historyResponse = await app.server.inject({
      method: "GET",
      url: `/api/rooms/${textRoom?.id}/messages`,
      cookies: member.cookies
    });
    const messages = historyResponse.json().messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].body, "oyuna giriyorum");
    assert.equal(messages[0].nickname, "Deniz");
    assert.equal(messages[0].editedAt, null);
  });

  it("lets members delete their own messages", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");

    const messageResponse = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: member.cookies,
      payload: { body: "sil beni" }
    });
    assert.equal(messageResponse.statusCode, 201);
    const messageId = messageResponse.json().message.id;

    const deleteResponse = await app.server.inject({
      method: "DELETE",
      url: `/api/rooms/general/messages/${messageId}`,
      cookies: member.cookies
    });
    assert.equal(deleteResponse.statusCode, 204);

    const historyResponse = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages",
      cookies: member.cookies
    });
    assert.equal(
      historyResponse.json().messages.some((message: { id: string }) => message.id === messageId),
      false
    );
  });

  it("limits message history and supports owner/member moderation rules", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Deniz");
    const secondMember = await acceptInvite(app, owner.cookies, "Ece");

    for (let index = 0; index < 105; index += 1) {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/rooms/general/messages",
        cookies: member.cookies,
        payload: { body: `message ${index}` }
      });
      assert.equal(response.statusCode, 201);
    }

    const defaultHistory = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages",
      cookies: member.cookies
    });
    assert.equal(defaultHistory.statusCode, 200);
    assert.equal(defaultHistory.json().messages.length, 100);
    assert.equal(defaultHistory.json().messages[0].body, "message 5");

    const limitedHistory = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages?limit=3",
      cookies: member.cookies
    });
    assert.equal(limitedHistory.json().messages.length, 3);

    const firstMessage = limitedHistory.json().messages[0];
    const editResponse = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${firstMessage.id}`,
      cookies: member.cookies,
      payload: { body: "edited message" }
    });
    assert.equal(editResponse.statusCode, 200);
    assert.equal(editResponse.json().message.body, "edited message");
    assert.equal(typeof editResponse.json().message.editedAt, "string");

    const ownerEditResponse = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${firstMessage.id}`,
      cookies: owner.cookies,
      payload: { body: "owner edit attempt" }
    });
    assert.equal(ownerEditResponse.statusCode, 403);

    const otherDeleteResponse = await app.server.inject({
      method: "DELETE",
      url: `/api/rooms/general/messages/${firstMessage.id}`,
      cookies: secondMember.cookies
    });
    assert.equal(otherDeleteResponse.statusCode, 403);

    const ownerDeleteResponse = await app.server.inject({
      method: "DELETE",
      url: `/api/rooms/general/messages/${firstMessage.id}`,
      cookies: owner.cookies
    });
    assert.equal(ownerDeleteResponse.statusCode, 204);

    const afterDeleteHistory = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages?limit=200",
      cookies: member.cookies
    });
    assert.equal(
      afterDeleteHistory.json().messages.some((message: { id: string }) => message.id === firstMessage.id),
      false
    );
  });
});

describe("Voxly static web serving", () => {
  it("serves the React build index for app routes when a web dist path is configured", async () => {
    const webDistPath = await mkdtemp(join(tmpdir(), "voxly-web-"));
    await writeFile(join(webDistPath, "index.html"), "<!doctype html><title>Voxly web</title>");
    const staticApp = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      secureCookies: false,
      webDistPath
    });

    try {
      const response = await staticApp.server.inject({
        method: "GET",
        url: "/app/text/general"
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.includes("Voxly web"), true);
    } finally {
      await staticApp.close();
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});

async function bootstrapOwner(app: VoxlyApp) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return {
    user: response.json().user,
    cookies: cookieJar(response)
  };
}

async function acceptInvite(app: VoxlyApp, ownerCookies: Record<string, string>, nickname: string) {
  const inviteResponse = await app.server.inject({
    method: "POST",
    url: "/api/owner/invites",
    cookies: ownerCookies,
    payload: { label: `${nickname} invite` }
  });

  const response = await app.server.inject({
    method: "POST",
    url: "/api/invites/accept",
    payload: { inviteToken: inviteResponse.json().invite.token, nickname }
  });

  return {
    user: response.json().user,
    cookies: cookieJar(response)
  };
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
