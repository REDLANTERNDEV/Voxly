import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { deviceLabel } from "../src/auth/deviceLabel.js";
import { createOpaqueToken, hashToken } from "../src/auth/tokens.js";

/**
 * A member's own Devices. The half of ADR-0014 that has to exist before
 * anything can mint a second one: an account nobody can inspect is one nobody
 * can defend, and both the Link code and the Recovery code depend on a member
 * being able to answer "was that me?".
 */
describe("a member's own Devices", () => {
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

  it("names the Device that signed in, and marks the one asking", async () => {
    const owner = await bootstrapOwner(app, chrome);

    const response = await app.server.inject({
      method: "GET",
      url: "/api/devices",
      cookies: owner.cookies
    });

    assert.equal(response.statusCode, 200);
    const devices = response.json().devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].label, "Chrome on Windows");
    assert.equal(devices[0].current, true);
  });

  it("keeps no version, so a browser update is not a new Device", async () => {
    const owner = await bootstrapOwner(app, chrome);

    const { devices } = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: owner.cookies
    })).json();

    assert.doesNotMatch(devices[0].label, /\d/);
  });

  it("shows a member only their own Devices", async () => {
    // The list is scoped to the caller; another account's sessions are not
    // something a member may enumerate.
    const owner = await bootstrapOwner(app, chrome);
    const member = await acceptInvite(app, owner.cookies, "Member", safari);

    const ownerDevices = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: owner.cookies
    })).json().devices;
    const memberDevices = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: member.cookies
    })).json().devices;

    assert.equal(ownerDevices.length, 1);
    assert.equal(memberDevices.length, 1);
    assert.equal(memberDevices[0].label, "Safari on iPhone");
    assert.notEqual(ownerDevices[0].id, memberDevices[0].id);
  });

  it("refuses to close somebody else's Device by id", async () => {
    // Scoped in the statement rather than by a check beforehand, so guessing an
    // id is not a way in.
    const owner = await bootstrapOwner(app, chrome);
    const member = await acceptInvite(app, owner.cookies, "Member", safari);
    const ownerDeviceId = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: owner.cookies
    })).json().devices[0].id;

    const response = await app.server.inject({
      method: "DELETE",
      url: `/api/devices/${ownerDeviceId}`,
      cookies: member.cookies
    });

    assert.equal(response.statusCode, 404);
    const stillThere = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: owner.cookies
    })).json().devices;
    assert.equal(stillThere.length, 1);
  });

  it("refuses to sign out the Device doing the asking", async () => {
    // That is logging out, which already exists and also has to clear the
    // cookie in front of you. Two ways to end the current session would have to
    // agree forever.
    const owner = await bootstrapOwner(app, chrome);
    const current = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: owner.cookies
    })).json().devices[0].id;

    const response = await app.server.inject({
      method: "DELETE",
      url: `/api/devices/${current}`,
      cookies: owner.cookies
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "cannot_revoke_current_device");
  });

  it("signs a Device out and stops its session working", async () => {
    const first = await bootstrapOwner(app, chrome);
    const second = linkAnotherDevice(app, first.user.id, safari);
    const devices = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: second.cookies
    })).json().devices;
    assert.equal(devices.length, 2);
    const other = devices.find((device: { current: boolean }) => !device.current);

    const revoked = await app.server.inject({
      method: "DELETE",
      url: `/api/devices/${other.id}`,
      cookies: second.cookies
    });

    assert.equal(revoked.statusCode, 200);
    const afterwards = await app.server.inject({
      method: "GET", url: "/api/devices", cookies: first.cookies
    });
    assert.equal(afterwards.statusCode, 401);
  });

  it("leaves the other Devices alone when one is signed out", async () => {
    // Signing out one Device must not be a global logout wearing a disguise.
    const owner = await bootstrapOwner(app, chrome);
    const second = linkAnotherDevice(app, owner.user.id, safari);
    const third = linkAnotherDevice(app, owner.user.id, firefox);
    const stale = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: third.cookies
    })).json().devices.find((device: { label: string }) => device.label === "Chrome on Windows");

    await app.server.inject({
      method: "DELETE", url: `/api/devices/${stale.id}`, cookies: third.cookies
    });

    for (const cookies of [second.cookies, third.cookies]) {
      const response = await app.server.inject({ method: "GET", url: "/api/devices", cookies });
      assert.equal(response.statusCode, 200);
    }
  });

  it("writes an audit line naming who closed it", async () => {
    const owner = await bootstrapOwner(app, chrome);
    const second = linkAnotherDevice(app, owner.user.id, safari);
    const stale = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: second.cookies
    })).json().devices.find((device: { current: boolean }) => !device.current);

    await app.server.inject({
      method: "DELETE", url: `/api/devices/${stale.id}`, cookies: second.cookies
    });

    const events = app.dumpTables().auditEvents as Array<{ action: string }>;
    assert.ok(events.some((event) => event.action === "device.revoked"));
  });

  it("answers nothing without a session", async () => {
    const response = await app.server.inject({ method: "GET", url: "/api/devices" });

    assert.equal(response.statusCode, 401);
  });
});

const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";

async function bootstrapOwner(app: VoxlyApp, userAgent: string) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    headers: { "user-agent": userAgent },
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

/**
 * A second session for an account that already has one.
 *
 * Written straight into `sessions` because there is no route that does this
 * yet — that absence is the entire gap ADR-0014 closes, and it is what the Link
 * code will mint. The row is the same shape `createSession` produces, so these
 * tests exercise the real list rather than a fixture shaped to suit them.
 */
function linkAnotherDevice(app: VoxlyApp, userId: string, userAgent: string) {
  const token = createOpaqueToken();
  const now = new Date();
  app.sqlite
    .prepare("insert into sessions (id, token_hash, user_id, created_at, expires_at, label, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)")
    .run(
      crypto.randomUUID(),
      hashToken(token),
      userId,
      now.toISOString(),
      new Date(now.getTime() + 86_400_000).toISOString(),
      deviceLabel(userAgent),
      now.toISOString()
    );

  return { cookies: { voxly_session: token } };
}

async function acceptInvite(app: VoxlyApp, ownerCookies: Record<string, string>, nickname: string, userAgent: string) {
  const inviteResponse = await app.server.inject({
    method: "POST",
    url: "/api/owner/invites",
    cookies: ownerCookies,
    payload: { label: `${nickname} invite` }
  });

  const response = await app.server.inject({
    method: "POST",
    url: "/api/invites/accept",
    headers: { "user-agent": userAgent },
    payload: { inviteToken: inviteResponse.json().invite.token, nickname }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
