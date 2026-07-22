import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { createOwnerClaim, createOwnerLoginClaim } from "../src/auth/ownerClaims.js";
import { defaultServerId, one, openDatabase, run } from "../src/db/database.js";
import { createRtcConfigProvider } from "../src/rtcConfig.js";

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

  it("migrates legacy SQLite data into the default server without discarding it", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-legacy-migration-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      create table users (id text primary key, nickname text not null, role text not null, banned_at text);
      create table invites (id text primary key, token_hash text not null unique, label text, created_by_user_id text not null, used_by_user_id text, used_at text, expires_at text, revoked_at text, created_at text not null);
      create table rooms (id text primary key, name text not null, kind text not null, position integer not null);
      create table messages (id text primary key, room_id text not null, user_id text not null, body text not null, created_at text not null, edited_at text, deleted_at text, deleted_by_user_id text);
      create table sessions (id text primary key, token_hash text not null unique, user_id text not null, created_at text not null, expires_at text not null, revoked_at text);
      create table owner_claims (id text primary key, token_hash text not null unique, user_id text not null, created_at text not null, expires_at text not null, consumed_at text);
      create table access_claims (id text primary key, token_hash text not null unique, user_id text not null, server_id text not null, created_by_user_id text not null, created_at text not null, expires_at text not null, consumed_at text);
      create table audit_events (id text primary key, actor_user_id text, action text not null, target_user_id text, created_at text not null);
    `);
    legacy.prepare("insert into users values (?, ?, ?, ?)").run("owner", "Red Lantern", "owner", null);
    legacy.prepare("insert into rooms values (?, ?, ?, ?)").run("history", "history", "text", 50);
    legacy.prepare("insert into invites values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("invite", "legacy-token-hash", "Legacy", "owner", null, null, null, null, "2026-01-01T00:00:00.000Z");
    legacy.close();

    const migrated = await openDatabase(databasePath);
    try {
      const tables = migrated.sqlite;
      const server = tables.prepare("select id, name from servers where id = ?").get(defaultServerId) as { id: string; name: string };
      assert.equal(server.id, defaultServerId);
      assert.equal(server.name, "The Basement");
      assert.equal(tables.prepare("select server_id from rooms where id = 'history'").get()?.server_id, defaultServerId);
      assert.equal(tables.prepare("select server_id from invites where id = 'invite'").get()?.server_id, defaultServerId);
      const membership = tables.prepare("select server_id, role from server_members where user_id = 'owner'").get() as { server_id: string; role: string };
      assert.equal(membership.server_id, defaultServerId);
      assert.equal(membership.role, "owner");
      const memberColumns = tables.prepare("pragma table_info(server_members)").all()
        .map((column) => (column as { name: string }).name);
      assert.ok(memberColumns.includes("nickname"));
      assert.equal(
        tables.prepare("select nickname from server_members where user_id = 'owner'").get()?.nickname,
        null
      );
      const indexNames = [
        ...tables.prepare("select name from sqlite_master where type = 'index'").all()
      ].map((index) => (index as { name: string }).name);
      for (const indexName of ["idx_server_members_user", "idx_rooms_server_position", "idx_invites_server_created", "idx_messages_room_created"]) {
        assert.ok(indexNames.includes(indexName));
      }
      const accessClaimColumns = tables.prepare("pragma table_info(access_claims)").all()
        .map((column) => (column as { name: string }).name);
      assert.ok(accessClaimColumns.includes("revoked_at"));
      const messageColumns = tables.prepare("pragma table_info(messages)").all()
        .map((column) => (column as { name: string }).name);
      assert.ok(messageColumns.includes("suppressed_embed_keys"));
    } finally {
      migrated.close();
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("does not recreate a deleted default server when another server remains", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-deleted-default-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const initial = await openDatabase(databasePath);
    let initialClosed = false;

    try {
      run(initial.sqlite, "insert into servers (id, name, created_at) values (?, ?, ?)", ["remaining", "Remaining", new Date().toISOString()]);
      run(initial.sqlite, "insert into rooms (id, server_id, name, kind, position) values (?, ?, ?, ?, ?)", ["remaining-general", "remaining", "general", "text", 10]);
      run(initial.sqlite, "delete from rooms where server_id = ?", [defaultServerId]);
      run(initial.sqlite, "delete from server_members where server_id = ?", [defaultServerId]);
      run(initial.sqlite, "delete from servers where id = ?", [defaultServerId]);
      initial.close();
      initialClosed = true;

      const reopened = await openDatabase(databasePath);
      try {
        assert.equal(one<{ count: number }>(reopened.sqlite, "select count(*) as count from servers where id = ?", [defaultServerId])?.count, 0);
        assert.equal(one<{ count: number }>(reopened.sqlite, "select count(*) as count from servers where id = 'remaining'")?.count, 1);
      } finally {
        reopened.close();
      }
    } finally {
      if (!initialClosed) initial.close();
      await rm(databaseDir, { force: true, recursive: true });
    }
  });

  it("does not add modern server members to the default server after restart", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "voxly-membership-restart-"));
    const databasePath = join(databaseDir, "voxly.sqlite");
    const initial = await openDatabase(databasePath);
    let initialClosed = false;

    try {
      const now = new Date().toISOString();
      run(initial.sqlite, "insert into users (id, nickname, role) values (?, ?, ?)", ["second-member", "Second member", "member"]);
      run(initial.sqlite, "insert into servers (id, name, created_at) values (?, ?, ?)", ["second-server", "Second server", now]);
      run(
        initial.sqlite,
        "insert into server_members (server_id, user_id, role, joined_at) values (?, ?, ?, ?)",
        ["second-server", "second-member", "member", now]
      );
      initial.close();
      initialClosed = true;

      const reopened = await openDatabase(databasePath);
      try {
        assert.equal(
          one<{ count: number }>(
            reopened.sqlite,
            "select count(*) as count from server_members where server_id = ? and user_id = ?",
            [defaultServerId, "second-member"]
          )?.count,
          0
        );
        assert.equal(
          one<{ count: number }>(
            reopened.sqlite,
            "select count(*) as count from server_members where server_id = ? and user_id = ?",
            ["second-server", "second-member"]
          )?.count,
          1
        );
      } finally {
        reopened.close();
      }
    } finally {
      if (!initialClosed) initial.close();
      await rm(databaseDir, { force: true, recursive: true });
    }
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

  it("keeps TURN credentials out of public config", async () => {
    const response = await app.server.inject({
      method: "GET",
      url: "/api/config"
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().publicUrl, "https://voxly.example.com");
    assert.equal("rtc" in response.json(), false);
    assert.equal(response.json().turnstile, null);
  });

  it("returns user-scoped RTC config only to authenticated users", async () => {
    const rtcApp = await createVoxlyApp({
      databasePath: ":memory:",
      ownerBootstrapToken: "bootstrap-secret",
      allowHttpOwnerBootstrap: true,
      secureCookies: false,
      rtc: createRtcConfigProvider({
        TURN_REALM: "turn.voxly.example",
        TURN_STATIC_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        TURN_CREDENTIAL_TTL_SECONDS: "3600"
      })
    });
    try {
      const unauthorized = await rtcApp.server.inject({ method: "GET", url: "/api/rtc/config" });
      assert.equal(unauthorized.statusCode, 401);

      const owner = await bootstrapOwner(rtcApp);
      const response = await rtcApp.server.inject({
        method: "GET",
        url: "/api/rtc/config",
        cookies: owner.cookies
      });
      assert.equal(response.statusCode, 200);
      assert.equal(typeof response.json().expiresAt, "number");
      const turn = response.json().iceServers.find((server: { username?: string }) => server.username);
      assert.match(turn.username, new RegExp(`^[0-9]+:${owner.user.id}$`));
      assert.equal(typeof turn.credential, "string");
    } finally {
      await rtcApp.close();
    }
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
    assert.deepEqual(messages[0].suppressedEmbedKeys, []);
  });

  it("lets message authors and server owners suppress individual embeds", async () => {
    const owner = await bootstrapOwner(app);
    const author = await acceptInvite(app, owner.cookies, "Author");
    const otherMember = await acceptInvite(app, owner.cookies, "Other member");
    const created = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: author.cookies,
      payload: { body: "https://youtu.be/dQw4w9WgXcQ https://x.com/user/status/123" }
    });
    const messageId = created.json().message.id as string;
    assert.deepEqual(created.json().message.suppressedEmbedKeys, []);

    const forbidden = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${messageId}/embeds`,
      cookies: otherMember.cookies,
      payload: { embedKey: "youtube:dQw4w9WgXcQ" }
    });
    assert.equal(forbidden.statusCode, 403);

    const authorSuppressed = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${messageId}/embeds`,
      cookies: author.cookies,
      payload: { embedKey: "youtube:dQw4w9WgXcQ" }
    });
    assert.equal(authorSuppressed.statusCode, 200);
    assert.deepEqual(authorSuppressed.json().message.suppressedEmbedKeys, ["youtube:dQw4w9WgXcQ"]);

    const ownerSuppressed = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${messageId}/embeds`,
      cookies: owner.cookies,
      payload: { embedKey: "x:123" }
    });
    assert.equal(ownerSuppressed.statusCode, 200);
    assert.deepEqual(ownerSuppressed.json().message.suppressedEmbedKeys, ["youtube:dQw4w9WgXcQ", "x:123"]);

    const history = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages",
      cookies: author.cookies
    });
    assert.deepEqual(history.json().messages[0].suppressedEmbedKeys, ["youtube:dQw4w9WgXcQ", "x:123"]);
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

  it("scopes channels, invites, memberships, and bans to a server", async () => {
    const owner = await bootstrapOwner(app);
    const firstMember = await acceptInvite(app, owner.cookies, "Ada");

    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    assert.equal(createdServer.statusCode, 201);
    const server = createdServer.json().server as { id: string; name: string };
    assert.equal(server.name, "Friday Games");

    const channel = await app.server.inject({
      method: "POST",
      url: `/api/servers/${server.id}/rooms`,
      cookies: owner.cookies,
      payload: { name: "raids", kind: "voice" }
    });
    assert.equal(channel.statusCode, 201);
    assert.equal(channel.json().room.serverId, server.id);

    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${server.id}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada Friday invite", expiresInHours: 24 }
    });
    assert.equal(invite.statusCode, 201);
    const usersBeforeSecondMembership = (app.dumpTables().users as unknown[]).length;
    const sessionsBeforeSecondMembership = (app.dumpTables().sessions as unknown[]).length;

    const joinedExistingAccount = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: firstMember.cookies,
      payload: { inviteToken: invite.json().invite.token }
    });
    assert.equal(joinedExistingAccount.statusCode, 200);
    assert.equal(joinedExistingAccount.json().user.id, firstMember.user.id);
    assert.equal(joinedExistingAccount.headers["set-cookie"], undefined);
    assert.equal((app.dumpTables().users as unknown[]).length, usersBeforeSecondMembership);
    assert.equal((app.dumpTables().sessions as unknown[]).length, sessionsBeforeSecondMembership);

    const servers = await app.server.inject({
      method: "GET",
      url: "/api/servers",
      cookies: firstMember.cookies
    });
    assert.equal(servers.statusCode, 200);
    assert.ok(servers.json().servers.some((item: { id: string }) => item.id === server.id));

    const ban = await app.server.inject({
      method: "POST",
      url: `/api/servers/${server.id}/members/${firstMember.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(ban.statusCode, 204);

    const inaccessibleRooms = await app.server.inject({
      method: "GET",
      url: `/api/servers/${server.id}/rooms`,
      cookies: firstMember.cookies
    });
    assert.equal(inaccessibleRooms.statusCode, 403);

    const defaultRoomsRemainAvailable = await app.server.inject({
      method: "GET",
      url: "/api/rooms",
      cookies: firstMember.cookies
    });
    assert.equal(defaultRoomsRemainAvailable.statusCode, 200);
  });

  it("renames a server for current members and resolves valid invites with the latest name", async () => {
    const owner = await bootstrapOwner(app);
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    const serverId = createdServer.json().server.id as string;
    const memberInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Member invite", expiresInHours: 24 }
    });
    const memberResponse = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      payload: { inviteToken: memberInvite.json().invite.token, nickname: "Ada" }
    });
    const memberCookies = cookieJar(memberResponse);
    const previewInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Later invite", expiresInHours: 24 }
    });
    const inviteToken = previewInvite.json().invite.token as string;

    const beforeRename = await app.server.inject({
      method: "POST",
      url: "/api/invites/preview",
      payload: { inviteToken }
    });
    assert.equal(beforeRename.statusCode, 200);
    assert.deepEqual(beforeRename.json(), { serverName: "Friday Games" });

    const forbiddenRename = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}`,
      cookies: memberCookies,
      payload: { name: "Member rename" }
    });
    assert.equal(forbiddenRename.statusCode, 403);

    const renamed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}`,
      cookies: owner.cookies,
      payload: { name: "Onyx Lounge" }
    });
    assert.equal(renamed.statusCode, 200);
    assert.deepEqual(renamed.json(), { server: { id: serverId, name: "Onyx Lounge", role: "owner" } });

    const afterRename = await app.server.inject({
      method: "POST",
      url: "/api/invites/preview",
      payload: { inviteToken }
    });
    assert.equal(afterRename.statusCode, 200);
    assert.deepEqual(afterRename.json(), { serverName: "Onyx Lounge" });

    const memberServers = await app.server.inject({
      method: "GET",
      url: "/api/servers",
      cookies: memberCookies
    });
    assert.equal(
      memberServers.json().servers.find((server: { id: string; name: string }) => server.id === serverId)?.name,
      "Onyx Lounge"
    );

    const invalidPreview = await app.server.inject({
      method: "POST",
      url: "/api/invites/preview",
      payload: { inviteToken: "x".repeat(24) }
    });
    assert.equal(invalidPreview.statusCode, 404);
    assert.deepEqual(invalidPreview.json(), { error: "invite_invalid" });
  });

  it("exposes an active member directory without owner moderation fields", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const outsider = await acceptInvite(app, owner.cookies, "Ece");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    const serverId = createdServer.json().server.id as string;
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada directory test", expiresInHours: 24 }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: invite.json().invite.token }
    });

    const visibleToMember = await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/directory`,
      cookies: member.cookies
    });
    assert.equal(visibleToMember.statusCode, 200);
    assert.deepEqual(
      visibleToMember.json().members.map((entry: Record<string, unknown>) => Object.keys(entry).sort()),
      [["nickname", "role", "userId"], ["nickname", "role", "userId"]]
    );
    assert.deepEqual(
      visibleToMember.json().members.map((entry: { nickname: string }) => entry.nickname),
      ["Ada", owner.user.nickname]
    );

    const hiddenFromOutsider = await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/directory`,
      cookies: outsider.cookies
    });
    assert.equal(hiddenFromOutsider.statusCode, 403);

    await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/members/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    const afterBan = await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/directory`,
      cookies: owner.cookies
    });
    assert.deepEqual(afterBan.json().members.map((entry: { nickname: string }) => entry.nickname), [owner.user.nickname]);
  });

  it("keeps owner-managed nicknames scoped to one server and current in messages", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    const secondServerId = createdServer.json().server.id as string;
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${secondServerId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ece Friday", expiresInHours: 24 }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: invite.json().invite.token }
    });

    const createdMessage = await app.server.inject({
      method: "POST",
      url: "/api/rooms/general/messages",
      cookies: member.cookies,
      payload: { body: "before rename" }
    });
    assert.equal(createdMessage.statusCode, 201);

    const renamed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}/members/${member.user.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "  Basement Ece  " }
    });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().user.nickname, "Basement Ece");

    const defaultDirectory = await app.server.inject({
      method: "GET",
      url: `/api/servers/${defaultServerId}/directory`,
      cookies: member.cookies
    });
    assert.equal(
      defaultDirectory.json().members.find((user: { userId: string }) => user.userId === member.user.id).nickname,
      "Basement Ece"
    );

    const secondDirectory = await app.server.inject({
      method: "GET",
      url: `/api/servers/${secondServerId}/directory`,
      cookies: member.cookies
    });
    assert.equal(
      secondDirectory.json().members.find((user: { userId: string }) => user.userId === member.user.id).nickname,
      "Ece"
    );

    const history = await app.server.inject({
      method: "GET",
      url: "/api/rooms/general/messages",
      cookies: member.cookies
    });
    assert.equal(history.json().messages[0].nickname, "Basement Ece");

    const edited = await app.server.inject({
      method: "PATCH",
      url: `/api/rooms/general/messages/${createdMessage.json().message.id}`,
      cookies: member.cookies,
      payload: { body: "after rename" }
    });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().message.nickname, "Basement Ece");

    const memberDenied = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}/members/${member.user.id}/nickname`,
      cookies: member.cookies,
      payload: { nickname: "Not allowed" }
    });
    assert.equal(memberDenied.statusCode, 403);

    const invalid = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}/members/${member.user.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "x" }
    });
    assert.equal(invalid.statusCode, 400);

    const ownerRenamed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}/members/${owner.user.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "Basement Owner" }
    });
    assert.equal(ownerRenamed.statusCode, 200);
    assert.equal(ownerRenamed.json().user.nickname, "Basement Owner");

    await app.server.inject({
      method: "POST",
      url: `/api/servers/${defaultServerId}/members/${member.user.id}/kick`,
      cookies: owner.cookies
    });
    const removed = await app.server.inject({
      method: "PATCH",
      url: `/api/servers/${defaultServerId}/members/${member.user.id}/nickname`,
      cookies: owner.cookies,
      payload: { nickname: "Removed Ece" }
    });
    assert.equal(removed.statusCode, 404);
  });

  it("keeps the first membership when an existing user accepts a second server invite", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    const secondServerId = createdServer.json().server.id as string;
    const secondServerInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${secondServerId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada second server", expiresInHours: 24 }
    });

    const joined = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: secondServerInvite.json().invite.token }
    });
    assert.equal(joined.statusCode, 200);
    assert.equal(joined.json().serverId, secondServerId);

    const visibleServers = await app.server.inject({
      method: "GET",
      url: "/api/servers",
      cookies: member.cookies
    });
    assert.equal(visibleServers.statusCode, 200);
    assert.deepEqual(
      visibleServers.json().servers.map((server: { id: string }) => server.id).sort(),
      [defaultServerId, secondServerId].sort()
    );

    const memberships = (app.dumpTables().serverMembers as Array<{ server_id: string; user_id: string }>)
      .filter((membership) => membership.user_id === member.user.id)
      .map((membership) => membership.server_id)
      .sort();
    assert.deepEqual(memberships, [defaultServerId, secondServerId].sort());
  });

  it("keeps a server invite unused when the current user is already an active member", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Friday Games" }
    });
    const serverId = createdServer.json().server.id as string;

    const firstInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada first invite", expiresInHours: 24 }
    });
    const firstJoin = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: firstInvite.json().invite.token }
    });
    assert.equal(firstJoin.statusCode, 200);

    const duplicateInvite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada duplicate invite", expiresInHours: 24 }
    });
    const duplicateJoin = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: duplicateInvite.json().invite.token }
    });

    assert.equal(duplicateJoin.statusCode, 409);
    assert.deepEqual(duplicateJoin.json(), { error: "already_server_member", serverId });
    const storedInvites = app.dumpTables().invites as Array<{ id: string; used_at: string | null }>;
    const storedInvite = storedInvites.find((invite) => invite.id === duplicateInvite.json().invite.id);
    assert.ok(storedInvite);
    assert.equal(storedInvite.used_at, null);
  });

  it("lets a kicked member rejoin with an invite but keeps banned-member invites unused", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ece");
    const createdServer = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Weekend Crew" }
    });
    const serverId = createdServer.json().server.id as string;
    const createInvite = (label: string) => app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label, expiresInHours: 24 }
    });

    const initialInvite = await createInvite("Initial membership");
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: initialInvite.json().invite.token }
    });
    const kicked = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/members/${member.user.id}/kick`,
      cookies: owner.cookies
    });
    assert.equal(kicked.statusCode, 204);
    const afterKick = await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/members`,
      cookies: owner.cookies
    });
    assert.equal(afterKick.statusCode, 200);
    assert.equal(afterKick.json().members.some((entry: { id: string }) => entry.id === member.user.id), false);

    const rejoinInvite = await createInvite("Rejoin after kick");
    const rejoin = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: rejoinInvite.json().invite.token }
    });
    assert.equal(rejoin.statusCode, 200);

    const banned = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/members/${member.user.id}/ban`,
      cookies: owner.cookies
    });
    assert.equal(banned.statusCode, 204);
    const afterBan = await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/members`,
      cookies: owner.cookies
    });
    assert.equal(afterBan.statusCode, 200);
    assert.equal(afterBan.json().members.some((entry: { id: string }) => entry.id === member.user.id), true);
    const bannedInvite = await createInvite("Must remain unused");
    const bannedJoin = await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: bannedInvite.json().invite.token }
    });
    assert.equal(bannedJoin.statusCode, 403);
    assert.deepEqual(bannedJoin.json(), { error: "server_banned" });
    const storedInvites = app.dumpTables().invites as Array<{ id: string; used_at: string | null }>;
    assert.equal(storedInvites.find((invite) => invite.id === bannedInvite.json().invite.id)?.used_at, null);
  });

  it("replaces one-time member access links without exposing their tokens", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Mehmet");
    const defaultServer = (await app.server.inject({
      method: "GET",
      url: "/api/servers",
      cookies: owner.cookies
    })).json().servers[0] as { id: string };

    const createAccessLink = () => app.server.inject({
      method: "POST",
      url: `/api/servers/${defaultServer.id}/members/${member.user.id}/access-links`,
      cookies: owner.cookies
    });
    const claim = (token: string) => app.server.inject({
      method: "POST",
      url: "/api/access/claim",
      payload: { token }
    });

    const first = await createAccessLink();
    const second = await createAccessLink();
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    const firstToken = first.json().token as string;
    const secondToken = second.json().token as string;

    const firstClaim = await claim(firstToken);
    assert.equal(firstClaim.statusCode, 404);
    assert.deepEqual(firstClaim.json(), { error: "access_claim_invalid" });

    const secondClaim = await claim(secondToken);
    assert.equal(secondClaim.statusCode, 201);
    assert.equal(secondClaim.json().user.id, member.user.id);
    assert.equal(secondClaim.json().serverId, defaultServer.id);

    const reused = await claim(secondToken);
    assert.equal(reused.statusCode, 404);

    const claims = app.dumpTables().accessClaims as Array<{
      revoked_at: string | null;
      consumed_at: string | null;
    }>;
    assert.equal(claims.filter((entry) => entry.revoked_at).length, 1);
    assert.equal(claims.filter((entry) => entry.consumed_at).length, 1);
    assert.equal(JSON.stringify(claims).includes(firstToken), false);
    assert.equal(JSON.stringify(claims).includes(secondToken), false);
  });

  it("lets only owners delete non-final channels and removes their messages", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const created = await app.server.inject({
      method: "POST",
      url: `/api/servers/${defaultServerId}/rooms`,
      cookies: owner.cookies,
      payload: { name: "temporary", kind: "text" }
    });
    const roomId = created.json().room.id as string;
    await app.server.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      cookies: owner.cookies,
      payload: { body: "delete with channel" }
    });

    const forbidden = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${defaultServerId}/rooms/${roomId}`,
      cookies: member.cookies
    });
    assert.equal(forbidden.statusCode, 403);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${defaultServerId}/rooms/${roomId}`,
      cookies: owner.cookies
    });
    assert.equal(deleted.statusCode, 204);
    assert.equal((app.dumpTables().rooms as Array<{ id: string }>).some((room) => room.id === roomId), false);
    assert.equal((app.dumpTables().messages as Array<{ room_id: string }>).some((message) => message.room_id === roomId), false);

    const lobbyDelete = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${defaultServerId}/rooms/lobby`,
      cookies: owner.cookies
    });
    assert.equal(lobbyDelete.statusCode, 204);
    const lastRoom = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${defaultServerId}/rooms/general`,
      cookies: owner.cookies
    });
    assert.equal(lastRoom.statusCode, 409);
    assert.deepEqual(lastRoom.json(), { error: "last_room" });
  });

  it("deletes a server atomically while preserving global identities and audit history", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Ada");
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Disposable server" }
    });
    const serverId = created.json().server.id as string;
    const invite = await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/invites`,
      cookies: owner.cookies,
      payload: { label: "Ada disposable", expiresInHours: 2 }
    });
    await app.server.inject({
      method: "POST",
      url: "/api/invites/accept",
      cookies: member.cookies,
      payload: { inviteToken: invite.json().invite.token }
    });
    await app.server.inject({
      method: "POST",
      url: `/api/servers/${serverId}/members/${member.user.id}/access-links`,
      cookies: owner.cookies
    });
    const rooms = (await app.server.inject({
      method: "GET",
      url: `/api/servers/${serverId}/rooms`,
      cookies: owner.cookies
    })).json().rooms as Array<{ id: string; kind: string }>;
    const textRoom = rooms.find((room) => room.kind === "text");
    assert.ok(textRoom);
    await app.server.inject({
      method: "POST",
      url: `/api/rooms/${textRoom.id}/messages`,
      cookies: owner.cookies,
      payload: { body: "cascade me" }
    });
    const usersBefore = (app.dumpTables().users as unknown[]).length;
    const sessionsBefore = (app.dumpTables().sessions as unknown[]).length;

    const forbidden = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}`,
      cookies: member.cookies
    });
    assert.equal(forbidden.statusCode, 403);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}`,
      cookies: owner.cookies
    });
    assert.equal(deleted.statusCode, 204);
    const tables = app.dumpTables();
    assert.equal((tables.servers as Array<{ id: string }>).some((server) => server.id === serverId), false);
    assert.equal((tables.rooms as Array<{ server_id: string }>).some((room) => room.server_id === serverId), false);
    assert.equal((tables.serverMembers as Array<{ server_id: string }>).some((membership) => membership.server_id === serverId), false);
    assert.equal((tables.invites as Array<{ server_id: string }>).some((entry) => entry.server_id === serverId), false);
    assert.equal((tables.accessClaims as Array<{ server_id: string }>).some((entry) => entry.server_id === serverId), false);
    assert.equal((tables.messages as Array<{ room_id: string }>).some((message) => rooms.some((room) => room.id === message.room_id)), false);
    assert.equal((tables.users as unknown[]).length, usersBefore);
    assert.equal((tables.sessions as unknown[]).length, sessionsBefore);
    assert.ok((tables.auditEvents as Array<{ action: string; server_id: string }>).some((event) => event.action === "server.deleted" && event.server_id === serverId));

    const lastServer = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${defaultServerId}`,
      cookies: owner.cookies
    });
    assert.equal(lastServer.statusCode, 409);
    assert.deepEqual(lastServer.json(), { error: "last_owner_server" });
  });

  it("allows deletion when the owner still has active member access elsewhere", async () => {
    const owner = await bootstrapOwner(app);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/servers",
      cookies: owner.cookies,
      payload: { name: "Owned server" }
    });
    const ownedServerId = created.json().server.id as string;
    run(app.sqlite, "update server_members set role = 'member' where server_id = ? and user_id = ?", [defaultServerId, owner.user.id]);

    const deleted = await app.server.inject({
      method: "DELETE",
      url: `/api/servers/${ownedServerId}`,
      cookies: owner.cookies
    });

    assert.equal(deleted.statusCode, 204);
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
