import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

/**
 * Bringing a second Device onto an account.
 *
 * The property worth defending is that **the code alone is not enough**. Voxly's
 * members share their screens constantly, so these lean on the approval step:
 * everything a leaked code can accomplish on its own must stop short of a
 * session. See ADR-0014.
 */
describe("linking a second Device", () => {
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

  it("links a Device once the member approves, and both stay signed in", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);

    const claim = await claimCode(app, code, phone);
    assert.equal(claim.statusCode, 200);
    // Pointedly not a session: claiming is asking, not arriving.
    assert.equal(claim.cookies.length, 0);

    const waiting = (await app.server.inject({
      method: "GET", url: "/api/devices/links/waiting", cookies: laptop.cookies
    })).json().waiting;
    assert.equal(waiting.confirmation, claim.json().confirmation);
    assert.equal(waiting.label, "Safari on iPhone");

    await approve(app, laptop.cookies, true);
    const collected = await collect(app, claim.json().claimToken, phone);

    assert.equal(collected.json().status, "approved");
    const phoneCookies = cookieJar(collected);
    assert.ok(phoneCookies.voxly_session);
    // Nothing is revoked: this is the path that keeps both Devices.
    for (const cookies of [laptop.cookies, phoneCookies]) {
      assert.equal((await app.server.inject({ method: "GET", url: "/api/devices", cookies })).statusCode, 200);
    }
    const devices = (await app.server.inject({
      method: "GET", url: "/api/devices", cookies: phoneCookies
    })).json().devices;
    assert.equal(devices.length, 2);
    assert.ok(devices.some((device: { label: string }) => device.label === "Safari on iPhone"));
  });

  it("hands out nothing while approval is still waiting", async () => {
    // The whole design: somebody who read the code off a screen share holds a
    // claim and gets pending, forever, unless the member approves.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);

    const collected = await collect(app, claim.json().claimToken, phone);

    assert.equal(collected.json().status, "pending");
    assert.equal(collected.cookies.length, 0);
  });

  it("refuses, and the refused Device never becomes a session", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);

    await approve(app, laptop.cookies, false);
    const collected = await collect(app, claim.json().claimToken, phone);

    assert.equal(collected.json().status, "refused");
    assert.equal(collected.cookies.length, 0);
  });

  it("a refusal rejects that claim, not the code", async () => {
    // Refusing used to consume the link, so a member who refused by mistake was
    // left holding a code with a minute still on it that no longer worked, and
    // no way to tell why. Typing it again has to work.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);
    await approve(app, laptop.cookies, false);

    const second = await claimCode(app, code, phone);

    assert.equal(second.statusCode, 200);
    await approve(app, laptop.cookies, true);
    const collected = await collect(app, second.json().claimToken, phone);
    assert.equal(collected.json().status, "approved");
  });

  it("does not let claim-and-refuse keep a code alive for ever", async () => {
    // Only the first claim moves the deadline. Otherwise the ninety seconds
    // could be renewed indefinitely by asking and being turned away in turn.
    const laptop = await bootstrapOwner(app);
    const { code, linkId } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);
    const afterFirst = expiryOf(app, linkId);
    await approve(app, laptop.cookies, false);

    await claimCode(app, code, phone);

    assert.equal(expiryOf(app, linkId), afterFirst, "the second claim extended the deadline");
  });

  it("stops answering the refused claim token once somebody claims afresh", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const first = await claimCode(app, code, phone);
    await approve(app, laptop.cookies, false);
    await claimCode(app, code, phone);

    const stale = await collect(app, first.json().claimToken, phone);

    assert.equal(stale.statusCode, 404);
  });

  it("lets only the Device that claimed the code collect the session", async () => {
    // A bystander who saw the code cannot poll for what it eventually mints:
    // the claim token is full entropy and is never displayed.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);
    await approve(app, laptop.cookies, true);

    const bystander = await collect(app, code, phone);

    assert.equal(bystander.statusCode, 404);
    assert.equal(bystander.cookies.length, 0);
  });

  it("can be claimed only once", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);

    const second = await claimCode(app, code, phone);

    assert.equal(second.statusCode, 404);
    assert.equal(second.json().error, "link_invalid");
  });

  it("mints at most one session from an approved link", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);
    await approve(app, laptop.cookies, true);

    const first = await collect(app, claim.json().claimToken, phone);
    const second = await collect(app, claim.json().claimToken, phone);

    assert.equal(first.json().status, "approved");
    assert.equal(second.json().status, "expired");
    assert.equal(second.cookies.length, 0);
  });

  it("answers the same way for unknown, malformed and already-used codes", async () => {
    // Three answers would be an oracle telling a guesser which half was right.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);

    const answers = await Promise.all([
      claimCode(app, "ZZZZZZZZZZ", phone),
      claimCode(app, "nonsense", phone),
      claimCode(app, code, phone)
    ]);

    for (const answer of answers) {
      assert.equal(answer.statusCode, 404);
      assert.equal(answer.json().error, "link_invalid");
    }
  });

  it("retires the previous code when a member asks for another", async () => {
    // Opening the dialog twice is changing your mind, not asking for two ways in.
    const laptop = await bootstrapOwner(app);
    const first = await mintCode(app, laptop.cookies);
    await mintCode(app, laptop.cookies);

    const stale = await claimCode(app, first.code, phone);

    assert.equal(stale.statusCode, 404);
  });

  it("kills the code when the dialog closes", async () => {
    const laptop = await bootstrapOwner(app);
    const { code, linkId } = await mintCode(app, laptop.cookies);

    await app.server.inject({
      method: "DELETE",
      url: `/api/devices/links/${linkId}`,
      cookies: laptop.cookies
    });

    assert.equal((await claimCode(app, code, phone)).statusCode, 404);
  });

  it("says how long the code has, not only when it dies", async () => {
    // A member whose clock is a few minutes out would otherwise be shown a
    // countdown that is wrong with it — "expired" on a code that works, or
    // minutes on one that does not. The absolute time stays authoritative on
    // the server; the duration is what the counter on screen uses.
    const laptop = await bootstrapOwner(app);

    const minted = await app.server.inject({ method: "POST", url: "/api/devices/links", cookies: laptop.cookies });

    assert.equal(minted.json().expiresInSeconds, 90);
    assert.ok(minted.json().expiresAt);
  });

  it("does not take back an approval when the dialog closes", async () => {
    // The bug the QR path exposed. Scanning is quick enough that the member
    // reaches "Done" on the minting Device before the arriving one's next poll,
    // and closing the dialog retired the link the approval had just blessed —
    // so the phone was told its code had expired a second after it was let in.
    // Typing the code by hand was slow enough to hide it.
    const laptop = await bootstrapOwner(app);
    const { code, linkId } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);
    await approve(app, laptop.cookies, true);

    await app.server.inject({
      method: "DELETE",
      url: `/api/devices/links/${linkId}`,
      cookies: laptop.cookies
    });

    const collected = await collect(app, claim.json().claimToken, phone);
    assert.equal(collected.json().status, "approved");
    assert.ok(cookieJar(collected).voxly_session);
  });

  it("does not take back an approval when another code is minted", async () => {
    // Same hazard through the other door: minting retires what is outstanding,
    // and an approved link is not outstanding — it is a session waiting to be
    // picked up.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);
    await approve(app, laptop.cookies, true);

    await mintCode(app, laptop.cookies);

    assert.equal((await collect(app, claim.json().claimToken, phone)).json().status, "approved");
  });

  it("retires only the code it was asked to, not whatever is outstanding", async () => {
    // A client that mints twice in quick succession — React's development
    // double-mount does exactly this — would otherwise have its live code
    // killed by the previous one's cleanup, and the member would be told a
    // perfectly good code had expired. That happened, on a real attempt.
    const laptop = await bootstrapOwner(app);
    const first = await mintCode(app, laptop.cookies);
    const second = await mintCode(app, laptop.cookies);

    await app.server.inject({
      method: "DELETE",
      url: `/api/devices/links/${first.linkId}`,
      cookies: laptop.cookies
    });

    assert.equal((await claimCode(app, second.code, phone)).statusCode, 200);
  });

  it("will not let a member retire somebody else's code", async () => {
    const laptop = await bootstrapOwner(app);
    const { code, linkId } = await mintCode(app, laptop.cookies);
    const other = await acceptInvite(app, laptop.cookies, "Ece");

    await app.server.inject({
      method: "DELETE",
      url: `/api/devices/links/${linkId}`,
      cookies: other.cookies
    });

    assert.equal((await claimCode(app, code, phone)).statusCode, 200);
  });

  it("accepts the code as it was displayed", async () => {
    // Grouping dashes are display, and a phone keyboard adds case and spaces.
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);

    const claim = await claimCode(app, ` ${code.toLowerCase()} `, phone);

    assert.equal(claim.statusCode, 200);
  });

  it("will not approve a claim that has expired", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    const claim = await claimCode(app, code, phone);
    expireLinks(app);

    const approved = await approve(app, laptop.cookies, true);

    assert.equal(approved.statusCode, 404);
    assert.equal((await collect(app, claim.json().claimToken, phone)).json().status, "expired");
  });

  it("shows the minting Device nothing until somebody claims", async () => {
    const laptop = await bootstrapOwner(app);
    await mintCode(app, laptop.cookies);

    const waiting = (await app.server.inject({
      method: "GET", url: "/api/devices/links/waiting", cookies: laptop.cookies
    })).json().waiting;

    assert.equal(waiting, null);
  });

  it("mints nothing for a caller with no session", async () => {
    const response = await app.server.inject({ method: "POST", url: "/api/devices/links" });

    assert.equal(response.statusCode, 401);
  });

  it("writes an audit line when a Device is linked", async () => {
    const laptop = await bootstrapOwner(app);
    const { code } = await mintCode(app, laptop.cookies);
    await claimCode(app, code, phone);
    await approve(app, laptop.cookies, true);

    const events = app.dumpTables().auditEvents as Array<{ action: string }>;
    assert.ok(events.some((event) => event.action === "device.linked"));
  });
});

const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

async function bootstrapOwner(app: VoxlyApp) {
  const response = await app.server.inject({
    method: "POST",
    url: "/api/bootstrap/owner",
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" },
    payload: { bootstrapToken: "bootstrap-secret", nickname: "Owner" }
  });

  return { user: response.json().user, cookies: cookieJar(response) };
}

async function mintCode(app: VoxlyApp, cookies: Record<string, string>) {
  const response = await app.server.inject({ method: "POST", url: "/api/devices/links", cookies });
  return {
    code: response.json().code as string,
    linkId: response.json().linkId as string,
    response
  };
}

function claimCode(app: VoxlyApp, code: string, userAgent: string) {
  return app.server.inject({
    method: "POST",
    url: "/api/devices/links/claim",
    headers: { "user-agent": userAgent },
    payload: { code }
  });
}

function approve(app: VoxlyApp, cookies: Record<string, string>, approveIt: boolean) {
  return app.server.inject({
    method: "POST",
    url: "/api/devices/links/approve",
    cookies,
    payload: { approve: approveIt }
  });
}

function collect(app: VoxlyApp, claimToken: string, userAgent: string) {
  return app.server.inject({
    method: "POST",
    url: "/api/devices/links/collect",
    headers: { "user-agent": userAgent },
    payload: { claimToken }
  });
}

/** Ages every live link past its deadline without waiting ninety seconds. */
function expireLinks(app: VoxlyApp) {
  app.sqlite
    .prepare("update device_links set expires_at = ?")
    .run(new Date(Date.now() - 1000).toISOString());
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

function expiryOf(app: VoxlyApp, linkId: string) {
  const row = app.sqlite
    .prepare("select expires_at from device_links where id = ?")
    .get(linkId) as { expires_at: string } | undefined;
  return row?.expires_at ?? "";
}

function cookieJar(response: { cookies: Array<{ name: string; value: string }> }) {
  return Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));
}
