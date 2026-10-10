import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createVoxlyApp } from "../src/app.js";
import { cookieJar } from "./sessionCookies.js";
import { audit } from "../src/audit.js";
import { sessionDiagnostics } from "../src/auth/sessionDiagnostics.js";
import { authenticateHttp, authenticateSocket, createSession, sessionCookieNameFor } from "../src/auth/sessions.js";
import { hashToken } from "../src/auth/tokens.js";
import { openDatabase } from "../src/db/database.js";

test("the diagnostic CLI is read-only and excludes credentials and unrelated Accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voxly-session-diagnostics-"));
  const path = join(dir, "fixture.sqlite");
  try {
    const db = await openDatabase(path);
    db.sqlite.prepare("insert into users (id, nickname, role) values (?, ?, 'member')").run("member", "Member");
    db.sqlite.prepare("insert into users (id, nickname, role) values (?, ?, 'member')").run("other", "Other");
    const token = createSession(db, "member");
    const otherToken = createSession(db, "other");
    const id = db.sqlite.prepare("select id from sessions where user_id = 'member'").get()!.id as string;
    audit(db, "member", "session.logged_out", "member", undefined, id);
    audit(db, "other", "session.logged_out", "other");
    db.close();
    const before = await readFile(path);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../src/cli/diagnose-sessions.js", import.meta.url)),
        "--database",
        path,
        "--account-id",
        "member"
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      sessions: Array<{ id: string }>;
      events: Array<{ session_id: string }>;
    };
    assert.deepEqual(
      report.sessions.map((row) => row.id),
      [id]
    );
    assert.deepEqual(
      report.events.map((row) => row.session_id),
      [id]
    );
    for (const secret of [token, otherToken, hashToken(token), hashToken(otherToken)]) {
      assert.equal(result.stdout.includes(secret), false);
    }
    assert.equal(result.stdout.includes('"other"'), false);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnosing a legacy database does not migrate it", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`create table sessions (id text, user_id text, created_at text, expires_at text, revoked_at text);
      create table audit_events (id text, action text, actor_user_id text, target_user_id text, created_at text);
      insert into sessions values ('session', 'member', '2026-01-01', '2027-01-01', null);
      insert into audit_events values ('event', 'session.revoked', 'owner', 'session', '2026-10-10');`);
    const before = sqlite.prepare("pragma table_info(audit_events)").all();
    const report = sessionDiagnostics(sqlite, "member");
    assert.equal(report.sessions.length, 1);
    assert.equal(report.events.length, 1);
    assert.equal(report.events[0]?.session_id, null);
    assert.deepEqual(sqlite.prepare("pragma table_info(audit_events)").all(), before);
  } finally {
    sqlite.close();
  }
});

test("rejection logs correlate requests without credentials or token hashes", async () => {
  const db = await openDatabase(":memory:");
  try {
    db.sqlite.prepare("insert into users (id, nickname, role) values ('member', 'Member', 'member')").run();
    const token = createSession(db, "member");
    db.sqlite.prepare("update sessions set revoked_at = ?").run(new Date().toISOString());
    const records: unknown[] = [];
    const logger = { info: (record: unknown) => records.push(record) };
    const cookies = { [sessionCookieNameFor(token, false)]: token };
    const request = { cookies, headers: {}, id: "http-request", log: logger } as unknown as Parameters<
      typeof authenticateHttp
    >[1];
    const reply = {} as Parameters<typeof authenticateHttp>[2];
    assert.equal(authenticateHttp(db, request, reply, false).ok, false);
    authenticateSocket(
      db,
      Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      undefined,
      { logger: logger as unknown as Parameters<typeof authenticateHttp>[1]["log"], requestId: "socket-request" }
    );
    assert.equal(records.length, 2);
    const output = JSON.stringify(records);
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(hashToken(token)), false);
    assert.ok(output.includes('"reason":"revoked"'));
    assert.ok(output.includes("http-request") && output.includes("socket-request"));
  } finally {
    db.close();
  }
});

test("diagnostic migrations preserve an unconfirmed rotation and its rejection marker across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voxly-session-migration-"));
  const path = join(dir, "fixture.sqlite");
  try {
    const db = await openDatabase(path);
    db.sqlite
      .prepare(
        "insert into session_tokens (token_hash, session_id, superseded_at, replacement_seen_at, stale_rejected_at) values (?, ?, ?, null, ?)"
      )
      .run("fixture-hash", "fixture-session", "2026-10-10", "2026-10-11");
    audit(db, null, "session.stale_rejected", "member", undefined, "fixture-session");
    db.close();
    const reopened = await openDatabase(path);
    try {
      const row = reopened.sqlite.prepare("select replacement_seen_at, stale_rejected_at from session_tokens").get();
      assert.equal(row?.replacement_seen_at, null);
      assert.equal(row?.stale_rejected_at, "2026-10-11");
      assert.equal(reopened.sqlite.prepare("select session_id from audit_events").get()?.session_id, "fixture-session");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated browser credentials and confirmed predecessors survive a server restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voxly-session-restart-"));
  const path = join(dir, "fixture.sqlite");
  let app = await createVoxlyApp({
    databasePath: path,
    secureCookies: true,
    ownerBootstrapToken: "fixture",
    allowHttpOwnerBootstrap: true
  });
  try {
    const old = cookieJar(
      await app.server.inject({
        method: "POST",
        url: "/api/bootstrap/owner",
        payload: { bootstrapToken: "fixture", nickname: "Owner" }
      })
    );
    app.sqlite.prepare("update sessions set token_issued_at = ?").run(new Date(Date.now() - 16 * 60000).toISOString());
    const current = cookieJar(await app.server.inject({ method: "GET", url: "/api/me", cookies: old }));
    await app.server.inject({ method: "POST", url: "/api/session/confirm", cookies: current });
    app.sqlite
      .prepare("update session_tokens set replacement_seen_at = ?")
      .run(new Date(Date.now() - 3 * 60000).toISOString());
    await app.close();
    app = await createVoxlyApp({ databasePath: path, secureCookies: true });
    assert.equal((await app.server.inject({ method: "GET", url: "/api/me", cookies: old })).statusCode, 401);
    assert.equal((await app.server.inject({ method: "GET", url: "/api/me", cookies: current })).statusCode, 200);
    assert.equal(app.sqlite.prepare("select revoked_at from sessions").get()?.revoked_at, null);
    assert.equal(
      app.sqlite.prepare("select count(*) as n from audit_events where action = 'session.stale_rejected'").get()?.n,
      1
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
