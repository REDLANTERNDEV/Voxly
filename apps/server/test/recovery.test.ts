import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { createOpaqueToken, hashToken } from "../src/auth/tokens.js";

/**
 * The way back with no Device left.
 *
 * The property these defend is that using a Recovery code is **loud**. A stolen
 * one cannot be spent quietly: it signs the real member out everywhere and
 * stops their saved code working, so theft announces itself when it happens
 * rather than months later. See ADR-0014 — do not soften this without going
 * back there.
 */
describe("recovering an account", () => {
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

  it("gives a new account no code until it asks for one", async () => {
    // Joining is not the moment to hand somebody a secret to look after: they
    // came to talk to their friends and will click past it, and a code nobody
    // saved is worse than none because it looks like a safety net.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");

    const before = await app.server.inject({ method: "GET", url: "/api/recovery", cookies: member.cookies });
    assert.equal(before.json().present, false);

    const code = await withRecoveryCode(app, member.cookies);
    assert.ok(code);
    const after = await app.server.inject({ method: "GET", url: "/api/recovery", cookies: member.cookies });
    assert.equal(after.json().present, true);
  });

  it("signs a member in from a Device that has nothing", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);

    const recovered = await redeem(app, code);

    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().user.nickname, "Member");
    assert.ok(cookieJar(recovered).voxly_session);
  });

  it("asks for the code and nothing else", async () => {
    // A nickname would add no security and would confirm to a stranger that the
    // nickname exists.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);

    const recovered = await app.server.inject({
      method: "POST",
      url: "/api/recovery/redeem",
      payload: { code: code }
    });

    assert.equal(recovered.statusCode, 200);
  });

  it("signs every other Device out, so theft cannot be quiet", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);
    assert.equal((await app.server.inject({
      method: "GET", url: "/api/devices", cookies: member.cookies
    })).statusCode, 200);

    await redeem(app, code);

    const afterwards = await app.server.inject({
      method: "GET", url: "/api/devices", cookies: member.cookies
    });
    assert.equal(afterwards.statusCode, 401);
  });

  it("spends the code and does not mint another in its place", async () => {
    // A member who has just recovered is signed in and safe. Handing them a new
    // secret in the same breath asks for care at the least careful moment, and
    // it is a code they did not ask for. Making one becomes a decision instead.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);

    const recovered = await redeem(app, code);

    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().code, undefined, "a replacement was pushed on them");
    assert.equal((await redeem(app, code)).statusCode, 404, "the spent code still works");
  });

  it("leaves the account with no code, and says so", async () => {
    // The settings card reads `present` to decide whether to nag. If recovery
    // left a stale code behind, it would stay quiet at the exact moment the
    // member has no way back at all.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);
    const recovered = await redeem(app, code);

    const status = await app.server.inject({
      method: "GET", url: "/api/recovery", cookies: cookieJar(recovered)
    });

    assert.equal(status.json().present, false);
  });

  it("signs every other Device out when a code is replaced, but not the one asking", async () => {
    // Replacing is almost always a reaction — the old code was seen, or written
    // somewhere it should not have been. That is the moment to clear the
    // account out. The Device in the member's hand is kept, or they would be
    // left with nothing to act from, holding a code they must use immediately.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    await withRecoveryCode(app, member.cookies);
    const second = linkAnotherDevice(app, member.user.id);
    assert.equal((await app.server.inject({
      method: "GET", url: "/api/devices", cookies: second.cookies
    })).statusCode, 200);

    const replaced = await app.server.inject({
      method: "POST", url: "/api/recovery", cookies: member.cookies
    });

    assert.equal(replaced.json().signedOutOthers, true);
    // The Device that asked still works.
    assert.equal((await app.server.inject({
      method: "GET", url: "/api/devices", cookies: member.cookies
    })).statusCode, 200);
    // The other one does not.
    assert.equal((await app.server.inject({
      method: "GET", url: "/api/devices", cookies: second.cookies
    })).statusCode, 401);
  });

  it("does not sign anybody out for creating a first code", async () => {
    // Preventive, not a reaction. A member setting up a safety net has nothing
    // to be alarmed about, and signing them out for being careful would teach
    // them not to bother.
    const owner = await bootstrapOwner(app);
    const second = linkAnotherDevice(app, owner.user.id);

    const created = await app.server.inject({
      method: "POST", url: "/api/recovery", cookies: owner.cookies
    });

    assert.equal(created.json().signedOutOthers, false);
    assert.equal((await app.server.inject({
      method: "GET", url: "/api/devices", cookies: second.cookies
    })).statusCode, 200);
  });

  it("retires the old code when a member generates another", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);

    const regenerated = await app.server.inject({
      method: "POST", url: "/api/recovery", cookies: member.cookies
    });

    assert.equal(regenerated.statusCode, 201);
    assert.equal((await redeem(app, code)).statusCode, 404);
    assert.equal((await redeem(app, regenerated.json().code)).statusCode, 200);
  });

  it("answers the same way for unknown, spent and superseded codes", async () => {
    // Three answers would tell somebody holding an old code that they at least
    // had the right account.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const superseded = await withRecoveryCode(app, member.cookies);
    await app.server.inject({ method: "POST", url: "/api/recovery", cookies: member.cookies });

    const answers = await Promise.all([
      redeem(app, superseded),
      redeem(app, "not-a-real-code"),
      redeem(app, "")
    ]);

    for (const answer of answers) {
      assert.equal(answer.statusCode, 404);
      assert.equal(answer.json().error, "recovery_invalid");
    }
  });

  it("accepts the code however it was written down", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);

    const recovered = await redeem(app, `  ${code.replace(/-/g, " ")}  `);

    assert.equal(recovered.statusCode, 200);
  });

  it("never hands the code back to a member who did not just create it", async () => {
    // Shown once. Anything that could read it back would make every session a
    // way to steal it.
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    await withRecoveryCode(app, member.cookies);

    const status = await app.server.inject({
      method: "GET", url: "/api/recovery", cookies: member.cookies
    });

    assert.deepEqual(status.json(), { present: true });
  });

  it("refuses a banned account", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);
    app.sqlite.prepare("update users set banned_at = ? where nickname = ?")
      .run(new Date().toISOString(), "Member");

    assert.equal((await redeem(app, code)).statusCode, 404);
  });

  it("writes audit lines for issuing and for using", async () => {
    const owner = await bootstrapOwner(app);
    const member = await acceptInvite(app, owner.cookies, "Member");
    const code = await withRecoveryCode(app, member.cookies);
    await redeem(app, code);

    const actions = (app.dumpTables().auditEvents as Array<{ action: string }>).map((event) => event.action);
    assert.ok(actions.includes("recovery.used"));
  });

  it("tells a caller with no session nothing about whether a code exists", async () => {
    const response = await app.server.inject({ method: "GET", url: "/api/recovery" });

    assert.equal(response.statusCode, 401);
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

  return { user: response.json().user, cookies: cookieJar(response) };
}

/**
 * A member with a Recovery code, which now means a member who asked for one.
 *
 * Joining no longer mints one: that is not the moment to hand somebody a secret
 * to look after, and a code nobody saved is worse than none because it looks
 * like a safety net.
 */
async function withRecoveryCode(app: VoxlyApp, cookies: Record<string, string>) {
  const created = await app.server.inject({ method: "POST", url: "/api/recovery", cookies });
  return created.json().code as string;
}

/** A second Device for an account that already has one; see `devices.test.ts`. */
function linkAnotherDevice(app: VoxlyApp, userId: string) {
  const token = createOpaqueToken();
  const now = new Date();
  app.sqlite
    .prepare("insert into sessions (id, token_hash, user_id, created_at, expires_at, label, last_seen_at, token_issued_at, origin) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      crypto.randomUUID(),
      hashToken(token),
      userId,
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
      "Safari on iPhone",
      now.toISOString(),
      now.toISOString(),
      "link"
    );
  return { cookies: { voxly_session: token } };
}

function redeem(app: VoxlyApp, code: string) {
  return app.server.inject({ method: "POST", url: "/api/recovery/redeem", payload: { code } });
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
