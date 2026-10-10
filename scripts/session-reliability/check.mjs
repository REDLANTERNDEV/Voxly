// Disposable browser fixture. Build first; requires Playwright Chromium.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createVoxlyApp } from "../../apps/server/dist/src/app.js";

const profile = await mkdtemp(join(tmpdir(), "voxly-session-browser-"));
const app = await createVoxlyApp({
  databasePath: ":memory:",
  webDistPath: resolve("apps/web/dist"),
  ownerBootstrapToken: "session-browser-fixture",
  allowHttpOwnerBootstrap: true,
  secureCookies: false
});
const held = new Map();
let faultNextMe = false;
let meCount = 0;
function hold(name) {
  let release;
  let arrived;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let timer;
  const started = new Promise((resolve, reject) => {
    arrived = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => reject(new Error(`Response ${name} did not arrive`)), 10000);
  });
  const entry = { release, arrived, blocked, started };
  held.set(name, entry);
  return entry;
}
app.server.addHook("preHandler", async (request, reply) => {
  if (request.url === "/api/me") {
    meCount++;
    if (faultNextMe) {
      faultNextMe = false;
      reply.header("X-Fixture-Delay", "unauthorized").code(401).send({ error: "unauthorized" });
    }
  }
});
app.server.addHook("onSend", async (request, reply, payload) => {
  const name = reply.getHeader("X-Fixture-Delay") ?? new URL(request.url, "http://fixture").searchParams.get("fixture");
  const entry = held.get(name);
  if (entry) {
    entry.arrived();
    await entry.blocked;
    held.delete(name);
  }
  return payload;
});
let context;
let browser;
const errors = [];
try {
  await app.server.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.server.address().port}`;
  const room = `${base}/app/server/the-basement/text/general`;
  async function persistent() {
    const next = await chromium.launchPersistentContext(profile, { headless: true, locale: "en-US" });
    next.setDefaultTimeout(10000);
    await next.addInitScript(() => {
      if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem("voxly:language", "en");
    });
    next.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    return next;
  }
  async function post(client, path, data) {
    const response = await client.post(`${base}${path}`, { data, headers: { origin: base } });
    assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  }
  const older = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  async function me(client = context.request) {
    const response = await client.get(`${base}/api/me`);
    assert.equal(response.status(), 200);
    return response.json();
  }
  async function beginDelayed(page, name) {
    const entry = hold(name);
    const result = page.evaluate(async (path) => (await fetch(path)).status, `/api/me?fixture=${name}`);
    await entry.started;
    return { entry, result };
  }
  context = await persistent();
  const owner = await post(context.request, "/api/bootstrap/owner", {
    bootstrapToken: "session-browser-fixture",
    nickname: "Owner"
  });
  const sessionId = app.sqlite.prepare("select id from sessions where user_id = ?").get(owner.user.id).id;
  const page = await context.newPage();
  const tab = await context.newPage();
  await page.goto(room);
  await tab.goto(room);
  await expect(page.locator("#messageInput")).toBeVisible();
  await expect(tab.locator("#messageInput")).toBeVisible();
  await expect.poll(() => app.io.sockets.sockets.size).toBe(2);

  // Delay the real HTTP response *after* its DB commit and before cookie delivery.
  app.sqlite.prepare("update sessions set token_issued_at = ? where id = ?").run(older(16), sessionId);
  const rotation = await beginDelayed(page, "rotation");
  app.sqlite
    .prepare("update session_tokens set superseded_at = ? where session_id = ? and replacement_seen_at is null")
    .run(older(3), sessionId);
  assert.equal((await me()).user.id, owner.user.id); // Recover on the other tab's shared jar.
  await post(context.request, "/api/session/confirm");
  const currentBeforeLate = (await context.cookies()).filter((cookie) => cookie.name.startsWith("voxly_session_"));
  assert.equal(currentBeforeLate.length, 1);
  rotation.entry.release();
  assert.equal(await rotation.result, 200);
  assert.ok((await context.cookies()).some((cookie) => cookie.name === currentBeforeLate[0].name));
  assert.equal((await me()).user.id, owner.user.id);
  assert.equal((await context.cookies()).filter((cookie) => cookie.name.startsWith("voxly_session_")).length, 1);
  console.log("PASS: delayed rotation cannot overwrite a recovered cookie shared by two tabs");

  // A renewal response also cannot overwrite a subsequently rotated credential.
  app.sqlite
    .prepare("update sessions set last_seen_at = ?, token_issued_at = ? where id = ?")
    .run(older(16), new Date().toISOString(), sessionId);
  const renewal = await beginDelayed(page, "renewal");
  app.sqlite.prepare("update sessions set token_issued_at = ? where id = ?").run(older(16), sessionId);
  await me();
  await post(context.request, "/api/session/confirm");
  renewal.entry.release();
  assert.equal(await renewal.result, 200);
  await me();
  assert.equal(app.sqlite.prepare("select revoked_at from sessions where id = ?").get(sessionId).revoked_at, null);
  console.log("PASS: delayed renewal preserves the successor");

  const beforeReconnect = meCount;
  for (const socket of app.io.sockets.sockets.values()) socket.conn.close();
  await expect.poll(() => meCount).toBeGreaterThan(beforeReconnect);
  await expect.poll(() => app.io.sockets.sockets.size).toBe(2);
  await expect(page.locator("#messageInput")).toBeVisible();
  console.log("PASS: Socket.IO reconnect authenticates from actual current browser cookies");

  await context.close();
  context = await persistent();
  const reopened = await context.newPage();
  await reopened.goto(room);
  await expect(reopened.locator("#messageInput")).toBeVisible();
  assert.equal((await me()).user.id, owner.user.id);
  const sessions = app.sqlite.prepare("select id from sessions where user_id = ?").all(owner.user.id);
  assert.deepEqual(
    sessions.map((row) => row.id),
    [sessionId]
  );
  console.log("PASS: closing and reopening the persistent profile retains the same Session");

  // Keep the same mounted App: a delayed disconnect 401 races an Access link claim.
  browser = await chromium.launch({ headless: true });
  const admin = await browser.newContext();
  await admin.addCookies(await context.cookies());
  const invite = await post(admin.request, "/api/owner/invites", { label: "Race fixture" });
  const memberContext = await browser.newContext();
  const member = await post(memberContext.request, "/api/invites/accept", {
    inviteToken: invite.invite.token,
    nickname: "Member"
  });
  const access = await post(admin.request, `/api/servers/the-basement/members/${member.user.id}/access-links`);
  await expect.poll(() => app.io.sockets.sockets.size).toBe(1);
  const unauthorized = hold("unauthorized");
  faultNextMe = true;
  for (const socket of app.io.sockets.sockets.values()) socket.conn.close();
  await unauthorized.started;
  await reopened.evaluate((path) => {
    history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/access/claim#token=${access.token}`);
  await expect(reopened.locator("#messageInput")).toBeVisible();
  await expect.poll(async () => (await me()).user.id).toBe(member.user.id);
  const countAfterClaim = meCount;
  unauthorized.release();
  await expect.poll(() => held.has("unauthorized")).toBe(false);
  // Allow the old promise to settle and verify it neither retries nor clears auth.
  await reopened.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  assert.equal(meCount, countAfterClaim);
  await expect(reopened.locator("#messageInput")).toBeVisible();
  assert.equal(new URL(reopened.url()).pathname, "/app/server/the-basement/text/general");
  assert.equal((await me()).user.id, member.user.id);
  console.log("PASS: delayed reconnect 401 cannot clear successful Access link authentication");
  assert.deepEqual(errors, []);
} finally {
  for (const entry of held.values()) entry.release();
  await context?.close();
  await browser?.close();
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
