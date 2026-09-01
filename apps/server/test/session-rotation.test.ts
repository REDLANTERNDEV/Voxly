import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";

/**
 * Session tokens rotate, and a reused one reports its own theft.
 *
 * The property worth defending is that a stolen cookie is worth **fifteen
 * minutes of quiet**, and that spending it after that is loud: the moment the
 * real member's browser rotates, the thief's copy is retired, and the next use
 * of it kills the session in front of the member instead of continuing
 * silently. See ADR-0015.
 *
 * The member is not signed out every fifteen minutes. The session row is
 * long-lived; only the value in the cookie is not. These pin both halves.
 */
describe("session token rotation", () => {
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

  it("does not rotate a fresh token", async () => {
    // Every request rotating would multiply writes by request count and buy
    // nothing over fifteen minutes.
    const owner = await bootstrapOwner(app);

    const response = await request(app, owner.cookies);

    assert.equal(response.statusCode, 200);
    assert.equal(response.cookies.length, 0);
  });

  it("replaces the value once it is old, without ending the session", async () => {
    const owner = await bootstrapOwner(app);
    const sessionId = sessionIdOf(app, owner.cookies.voxly_session);
    ageToken(app, 16);

    const rotated = await request(app, owner.cookies);

    const next = cookieJar(rotated).voxly_session;
    assert.ok(next, "the token was not replaced");
    assert.notEqual(next, owner.cookies.voxly_session);
    // Same session throughout: this is re-carrying, not re-authenticating.
    assert.equal(sessionIdOf(app, next), sessionId);
    assert.equal((await request(app, { voxly_session: next })).statusCode, 200);
  });

  it("keeps the retired value working through its grace window", async () => {
    // Browsers fire requests in parallel and drop responses. Without this,
    // ordinary concurrency would look exactly like theft.
    const owner = await bootstrapOwner(app);
    ageToken(app, 16);
    await request(app, owner.cookies);

    const stale = await request(app, owner.cookies);

    assert.equal(stale.statusCode, 200);
  });

  it("does not rotate again on a retired value", async () => {
    // Rotating on the old one would retire the value the member is actually
    // holding, turning one lost response into a chain of them.
    const owner = await bootstrapOwner(app);
    ageToken(app, 16);
    await request(app, owner.cookies);
    ageToken(app, 16);

    const stale = await request(app, owner.cookies);

    assert.equal(stale.statusCode, 200);
    assert.equal(stale.cookies.length, 0);
  });

  it("treats a retired value used after the grace window as theft", async () => {
    const owner = await bootstrapOwner(app);
    ageToken(app, 16);
    const rotated = await request(app, owner.cookies);
    const current = cookieJar(rotated).voxly_session;
    ageRetiredTokens(app, 5);

    const reused = await request(app, owner.cookies);

    assert.equal(reused.statusCode, 401);
    assert.equal(reused.json().error, "session_reused");
    // Loud, not quiet: the session ends for the thief *and* for the member,
    // which is what makes the theft visible.
    assert.equal((await request(app, { voxly_session: current })).statusCode, 401);
    const actions = (app.dumpTables().auditEvents as Array<{ action: string }>).map((event) => event.action);
    assert.ok(actions.includes("session.reused"), "the reuse left no line for the owner");
  });

  it("produces one rotation under a burst of parallel requests", async () => {
    // The rotation is guarded on the value it was shown, so the loser of the
    // race keeps the cookie it already has rather than retiring the winner's.
    const owner = await bootstrapOwner(app);
    ageToken(app, 16);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => request(app, owner.cookies))
    );

    assert.ok(responses.every((response) => response.statusCode === 200));
    const issued = responses.flatMap((response) => response.cookies.map((cookie) => cookie.value));
    assert.equal(new Set(issued).size, 1, `issued ${issued.length} different tokens`);
  });

  it("slides the expiry forward every time the member is seen", async () => {
    // A member who keeps using Voxly is never signed out. Asking a self-hosted
    // group to prove who they are again, for no event that happened, is the
    // thing this avoids — expiry is for a Device nobody has touched in a whole
    // window, not for somebody who is right here.
    const owner = await bootstrapOwner(app);
    const before = expiryOf(app, owner.cookies.voxly_session);
    // Old enough that the touch throttle lets the renewal through.
    app.sqlite
      .prepare("update sessions set last_seen_at = ?")
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString());
    app.sqlite
      .prepare("update sessions set expires_at = ?")
      .run(new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString());

    const response = await request(app, owner.cookies);

    assert.equal(response.statusCode, 200);
    const after = expiryOf(app, owner.cookies.voxly_session);
    assert.ok(after > before - 1000, `expiry went backwards: ${after} < ${before}`);
    // Back out to a full window, not merely nudged.
    assert.ok(after - Date.now() > 170 * 24 * 60 * 60 * 1000, "the window did not reset");
  });

  it("ends a session nobody has used for a whole window", async () => {
    // A forgotten session on a machine somebody no longer owns should not
    // outlive their use of it — but that is the *expiry* doing it, not a
    // separate idle rule that could disagree with it.
    const owner = await bootstrapOwner(app);
    app.sqlite
      .prepare("update sessions set expires_at = ? where token_hash = ?")
      .run(new Date(Date.now() - 1000).toISOString(), hashToken(owner.cookies.voxly_session));

    assert.equal((await request(app, owner.cookies)).statusCode, 401);
  });

  it("still refuses an unknown token as an ordinary refusal", async () => {
    // Only a token this session actually carried is evidence. Anything else is
    // simply wrong, and calling it theft would cry wolf.
    const response = await request(app, { voxly_session: "not-a-real-token" });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "unauthorized");
  });

  it("forgets retired values once nobody could still ask about them", async () => {
    const owner = await bootstrapOwner(app);
    ageToken(app, 16);
    await request(app, owner.cookies);
    ageRetiredTokens(app, 31 * 24 * 60);
    ageToken(app, 16);

    // The next rotation sweeps anything past the memory window.
    const rotated = await request(app, cookieJar(await request(app, owner.cookies)));
    await request(app, cookieJar(rotated));

    const remaining = app.sqlite.prepare("select count(*) as count from session_tokens").get() as { count: number };
    assert.ok(remaining.count <= 1, `kept ${remaining.count} retired tokens`);
  });
});

function request(app: VoxlyApp, cookies: Record<string, string>) {
  return app.server.inject({ method: "GET", url: "/api/me", cookies });
}

/** Moves the current token's issue time into the past, in minutes. */
function ageToken(app: VoxlyApp, minutes: number) {
  app.sqlite
    .prepare("update sessions set token_issued_at = ?")
    .run(new Date(Date.now() - minutes * 60 * 1000).toISOString());
}

/** Moves every retired token past its grace window, in minutes. */
function ageRetiredTokens(app: VoxlyApp, minutes: number) {
  app.sqlite
    .prepare("update session_tokens set superseded_at = ?")
    .run(new Date(Date.now() - minutes * 60 * 1000).toISOString());
}

function expiryOf(app: VoxlyApp, token: string) {
  const row = app.sqlite
    .prepare("select expires_at from sessions where token_hash = ?")
    .get(hashToken(token)) as { expires_at: string } | undefined;
  return row ? new Date(row.expires_at).getTime() : 0;
}

function sessionIdOf(app: VoxlyApp, token: string) {
  return (app.sqlite
    .prepare("select id from sessions where token_hash = ?")
    .get(hashToken(token)) as { id: string } | undefined)?.id;
}

async function bootstrapOwner(app: VoxlyApp) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
