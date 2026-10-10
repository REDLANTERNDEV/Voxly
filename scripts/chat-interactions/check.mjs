// Disposable end-to-end fixture. Requires `npm run build` and Playwright Chromium.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, expect } from "@playwright/test";
import { createVoxlyApp } from "../../apps/server/dist/src/app.js";

const app = await createVoxlyApp({
  databasePath: ":memory:",
  webDistPath: resolve("apps/web/dist"),
  ownerBootstrapToken: "chat-browser-fixture",
  allowHttpOwnerBootstrap: true,
  secureCookies: false
});
let browser;
const errors = [];
try {
  await app.server.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHAT_BROWSER_CHANNEL ? { channel: process.env.CHAT_BROWSER_CHANNEL } : {})
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  context.setDefaultTimeout(10000);
  await context.addInitScript(() => {
    if (!localStorage.getItem("voxly:language")) localStorage.setItem("voxly:language", "en");
  });
  async function post(client, path, data) {
    const response = await client.post(`${base}${path}`, { data, headers: { origin: base } });
    assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
    return response.json();
  }
  const owner = await post(context.request, "/api/bootstrap/owner", {
    bootstrapToken: "chat-browser-fixture",
    nickname: "Owner"
  });
  const members = [];
  for (let index = 0; index < 2; index++) {
    const invite = await post(context.request, "/api/owner/invites", { label: "Browser fixture" });
    const memberContext = await browser.newContext({ locale: "en-US" });
    await memberContext.addInitScript(() => localStorage.setItem("voxly:language", "en"));
    const member = await post(memberContext.request, "/api/invites/accept", {
      inviteToken: invite.invite.token,
      nickname: "Ahmet"
    });
    members.push({ context: memberContext, user: member.user });
  }
  const oldIds = Array.from({ length: 210 }, () => crypto.randomUUID());
  const insert = app.sqlite.prepare(
    "insert into messages (id, room_id, user_id, body, created_at, sequence) values (?, 'general', ?, ?, ?, ?)"
  );
  oldIds.forEach((id, index) =>
    insert.run(id, owner.user.id, `Old message ${index}`, "2026-01-01T00:00:00.000Z", index + 1)
  );
  app.sqlite.prepare("update rooms set message_sequence = 210 where id = 'general'").run();
  await context.request.put(`${base}/api/rooms/general/messages/${oldIds[60]}/pin`, { headers: { origin: base } });
  const message = (
    await post(context.request, "/api/rooms/general/messages", {
      body: "Browser links https://example.test/chat https://youtu.be/dQw4w9WgXcQ"
    })
  ).message;
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  // No third-party fixture traffic is necessary for testing preview header links.
  await page.route("https://**", (route) => route.abort());
  await page.goto(`${base}/app/server/the-basement/text/general`);
  const field = page.locator("#messageInput");
  await expect(field).toBeVisible();
  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();

  // Native link contextmenu bubbles without being prevented; ordinary rows still use Voxly's menu.
  async function contextMenuPrevented(locator) {
    return locator.evaluate((element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 250 });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
  }
  assert.equal(await contextMenuPrevented(row.locator(".message-body a").first()), false);
  assert.equal(await contextMenuPrevented(row.locator(".message-embed-head a")), false);
  assert.equal(await contextMenuPrevented(row.locator(".message-body")), true);
  await expect(page.getByRole("menu", { name: "Message actions" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Picker inserts at the saved cursor without submitting the message.
  await field.fill("hello world");
  await field.press("Home");
  for (let index = 0; index < 6; index++) await field.press("ArrowRight");
  assert.equal(await field.evaluate((element) => element.selectionStart), 6);
  await page.getByRole("button", { name: "Add emoji", exact: true }).click();
  await page.getByRole("textbox", { name: "Search emojis" }).fill("pizza");
  await page.locator(".emoji-grid button").click();
  await expect(field).toHaveValue("hello 🍕world");
  await expect(field).toBeFocused();

  // Same names remain distinct, keyboard acceptance does not send, and the card has the chosen code.
  await field.fill("@");
  await field.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await expect(page.getByRole("option")).toHaveCount(0);
  await field.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true })
    )
  );
  await expect(field).toHaveValue("@");
  await field.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  const options = page.getByRole("option").filter({ hasText: "Ahmet" });
  await expect(options).toHaveCount(2);
  const firstLabel = await options.first().locator("span").textContent();
  const secondLabel = await options.last().locator("span").textContent();
  assert.notEqual(firstLabel, secondLabel);
  const targetIndex = (await page.getByRole("option").locator("span").allTextContents()).indexOf(firstLabel);
  for (let index = 0; index < targetIndex; index++) await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveValue(`${firstLabel} `);
  await field.press("Enter");
  const mentionRow = page
    .locator(".message")
    .filter({ has: page.locator("button.message-mention") })
    .last();
  await expect(mentionRow.locator("button.message-mention")).toBeVisible();
  await mentionRow.locator("button.message-mention").click();
  await expect(page.getByRole("dialog", { name: "Member details" })).toBeVisible();
  await expect(page.getByRole("dialog").locator(".mono")).toHaveText(firstLabel.match(/#[A-F0-9]{6}/)[0]);
  await page.keyboard.press("Escape");

  // Fill the shared ceiling, then exercise the owner controls in the real UI.
  const emojis = ["👍", "❤️", "😂", "🔥", "🎉", "😎", "🤔", "👏"];
  for (const emoji of emojis) {
    const response = await context.request.put(
      `${base}/api/rooms/general/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`,
      { headers: { origin: base } }
    );
    assert.ok(response.ok());
  }
  await expect(row.locator(".reaction-chip")).toHaveCount(8);
  assert.equal(
    await row
      .locator(".reaction-emoji")
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
    "20px"
  );
  assert.equal(
    await row
      .locator(".reaction-count")
      .first()
      .evaluate((element) => getComputedStyle(element).fontSize),
    "12px"
  );
  assert.ok(
    await row
      .locator(".reaction-chip")
      .first()
      .evaluate((element) => element.getBoundingClientRect().height >= 32)
  );
  await row.getByRole("button", { name: "Add a reaction", exact: true }).click();
  await expect(
    page.getByText("A message can have up to 8 different reaction emojis. You can still join an existing reaction.")
  ).toBeVisible();
  await expect(page.locator(".emoji-grid button").filter({ hasText: "😀" })).toBeDisabled();
  await expect(page.locator(".emoji-grid button").filter({ hasText: "👍" })).toBeEnabled();
  await page.keyboard.press("Escape");

  const memberPage = await members[0].context.newPage();
  memberPage.on("pageerror", (error) => errors.push(error.message));
  await memberPage.route("https://**", (route) => route.abort());
  await memberPage.goto(`${base}/app/server/the-basement/text/general`);
  const memberRow = memberPage.locator(`[data-message-id="${message.id}"]`);
  await expect(memberRow.locator(".reaction-chip")).toHaveCount(8);
  await memberRow.getByRole("button", { name: /^Add 👍 reaction/ }).click();
  await expect(row.getByRole("button", { name: /^Remove your 👍 reaction/ }).locator(".reaction-count")).toHaveText(
    "2"
  );
  await row.getByRole("button", { name: "People who reacted with 👍", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".reaction-people li")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove all 👍 reactions", exact: true }).click();
  await expect(row.locator(".reaction-chip")).toHaveCount(7);
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Message actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Remove all reactions", exact: true }).click();
  await expect(row.locator(".reaction-chip")).toHaveCount(0);
  await expect(memberRow.locator(".reaction-chip")).toHaveCount(0);
  await memberRow.getByRole("button", { name: "Message actions", exact: true }).click();
  await expect(memberPage.getByRole("menuitem", { name: "Remove all reactions", exact: true })).toHaveCount(0);
  await memberPage.keyboard.press("Escape");

  // An old pinned message opens its window and cannot mark unseen arrivals read.
  await page.getByRole("button", { name: "Pinned messages", exact: true }).click();
  await page.getByRole("dialog").getByRole("button").filter({ hasText: "Old message 60" }).click();
  await expect(page.locator(`[data-message-id="${oldIds[60]}"]`)).toHaveClass(/is-jump-target/);
  await expect(page.getByRole("button", { name: "Back to latest messages" })).toBeVisible();
  const cursor = () =>
    app.sqlite
      .prepare("select last_read_sequence as sequence from room_read_cursors where user_id = ? and room_id = 'general'")
      .get(owner.user.id)?.sequence ?? 0;
  const before = cursor();
  const arrival = (
    await post(members[0].context.request, "/api/rooms/general/messages", {
      body: "Unseen arrival while reading old pin"
    })
  ).message;
  await expect
    .poll(async () => (await context.request.get(`${base}/api/notifications`)).json())
    .toMatchObject({ servers: expect.any(Array) });
  await page.waitForTimeout(250);
  assert.equal(cursor(), before);
  assert.equal(await page.locator(`[data-message-id="${arrival.id}"]`).count(), 0);
  await page.getByRole("button", { name: "Back to latest messages" }).click();
  await expect(page.locator(`[data-message-id="${arrival.id}"]`)).toBeVisible();

  // Phone sizing remains usable with all eight groups, and Turkish controls are translated.
  for (const emoji of emojis)
    await context.request.put(
      `${base}/api/rooms/general/messages/${arrival.id}/reactions/${encodeURIComponent(emoji)}`,
      { headers: { origin: base } }
    );
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneRow = page.locator(`[data-message-id="${arrival.id}"]`);
  await expect(phoneRow.locator(".reaction-chip")).toHaveCount(8);
  await phoneRow.scrollIntoViewIfNeeded();
  await expect(phoneRow.locator(".reaction-chip").last()).toBeVisible();
  assert.ok(
    await phoneRow
      .locator(".reaction-chip")
      .first()
      .evaluate((element) => element.getBoundingClientRect().height >= 44)
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: process.env.CHAT_BROWSER_OUTPUT ?? join(tmpdir(), "voxly-chat-phone.png") });
  await page.evaluate(() => localStorage.setItem("voxly:language", "tr"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Emoji ekle", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sabitlenmiş mesajlar", exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("voxly:language", "en"));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();

  // Matching text typed before an existing label must keep that occurrence's targets.
  await field.fill("@here");
  await page
    .getByRole("option")
    .filter({ hasText: /^@here/ })
    .click();
  await field.press("Home");
  await field.press("@");
  await field.press("End");
  await field.press("Enter");
  const doubled = page.locator(".message:not(.message-pending)").filter({ hasText: "@@here" }).last();
  await expect(doubled.locator(".message-mention")).toHaveText("@here");
  const doubledId = await doubled.getAttribute("data-message-id");
  const doubleHistory = await (await context.request.get(`${base}/api/rooms/general/messages`)).json();
  const keptHere = doubleHistory.messages.find((item) => item.id === doubledId);
  assert.equal(keptHere.mentions.length, 1);
  assert.equal(keptHere.mentions[0].start, 1);

  const directory = await (await context.request.get(`${base}/api/servers/the-basement/directory`)).json();
  const target = directory.members.find((person) => person.userId === members[0].user.id);
  const targetLabel = `@${target.nickname} · #${target.mentionCode}`;
  const mentionInput = { kind: "person", userId: target.userId, start: 0, end: targetLabel.length };
  const editable = (
    await post(context.request, "/api/rooms/general/messages", { body: targetLabel, mentions: [mentionInput] })
  ).message;
  const editableRow = page.locator(`[data-message-id="${editable.id}"]`);
  // The draft reply author is also an identity snapshot, independent of history.
  await members[0].context.request.post(`${base}/api/rooms/general/messages`, {
    data: { body: "member authored" },
    headers: { origin: base }
  });
  const memberAuthored = page.locator(".message").filter({ hasText: "member authored" }).last();
  await expect(memberAuthored).toBeVisible();
  await memberAuthored.locator(".message-body").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply", exact: true }).click();
  await field.fill("@");
  await page
    .getByRole("option")
    .filter({ hasText: `#${target.mentionCode}` })
    .click();
  await field.press("End");
  await field.pressSequentially(" trailing text");
  await field.press("Home");
  await editableRow.locator(".message-body").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = editableRow.locator("textarea");
  await editor.focus();
  await editor.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length));
  await editor.pressSequentially(" preserved edit");
  const renamed = await context.request.patch(`${base}/api/servers/the-basement/members/${target.userId}/nickname`, {
    data: { nickname: "Deniz Uzun" },
    headers: { origin: base }
  });
  assert.ok(renamed.ok());
  await expect(field).toHaveValue(`@Deniz Uzun · #${target.mentionCode}  trailing text`);
  await expect(editor).toHaveValue(`@Deniz Uzun · #${target.mentionCode} preserved edit`);
  await expect(page.locator(".composer-reply-target")).toContainText("Deniz Uzun");
  assert.equal(await editor.evaluate((element) => element.selectionStart), (await editor.inputValue()).length);

  // Hold one delivery so the next one stays in the serial outbox through deletion.
  let releaseFirst;
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstSeen;
  const started = new Promise((resolve) => {
    firstSeen = resolve;
  });
  let queuedBody;
  const holdPosts = async (route) => {
    const input = route.request().postDataJSON();
    if (input?.body === "held delivery") {
      firstSeen();
      await held;
    } else queuedBody = input;
    await route.continue();
  };
  await page.route("**/api/rooms/general/messages", holdPosts);
  // Preserve the unsent composer while a second page queues another Mention.
  const queuePage = await context.newPage();
  queuePage.on("pageerror", (error) => errors.push(error.message));
  await queuePage.goto(`${base}/app/server/the-basement/text/general`);
  await queuePage.route("**/api/rooms/general/messages", holdPosts);
  const queueField = queuePage.locator("#messageInput");
  await queueField.fill("held delivery");
  await queueField.press("Enter");
  await started;
  await queueField.fill("@");
  await queuePage
    .getByRole("option")
    .filter({ hasText: `#${target.mentionCode}` })
    .click();
  await queueField.press("Enter");
  const removed = await context.request.delete(`${base}/api/owner/accounts/${target.userId}`, {
    data: { nickname: "Ahmet", permanent: true },
    headers: { origin: base }
  });
  assert.equal(removed.status(), 204);
  await expect(field).toHaveValue(`@#${target.mentionCode}  trailing text`);
  await expect(editor).toHaveValue(`@#${target.mentionCode} preserved edit`);
  await expect(page.locator(".composer-reply-target")).toContainText("Deleted member");
  await expect(queuePage.locator(".message-pending").last()).toContainText("Deleted member");
  releaseFirst();
  await expect.poll(() => queuedBody).toMatchObject({ body: `@#${target.mentionCode}`, mentions: [] });
  await expect(queuePage.locator(".message-pending")).toHaveCount(0);
  await queuePage.close();
  await page.unroute("**/api/rooms/general/messages", holdPosts);
  // Retained deleted mentions remain valid when the author's edited text is saved.
  await editableRow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editableRow.locator(".message-mention")).toHaveText("@Deleted member");
  await expect(editableRow).toContainText("preserved edit");
  await field.press("End");
  await field.press("Enter");
  await expect(
    page
      .locator(".message")
      .filter({ hasText: `@#${target.mentionCode}  trailing text` })
      .last()
  ).toBeVisible();
  const pinned = await context.request.put(`${base}/api/rooms/general/messages/${editable.id}/pin`, {
    headers: { origin: base }
  });
  assert.ok(pinned.ok());
  await page.getByRole("button", { name: "Pinned messages", exact: true }).click();
  const pinList = page.locator(".pinned-message-list");
  await expect(pinList).toContainText("preserved edit");
  const fresh = (
    await (await context.request.get(`${base}/api/rooms/general/messages/${editable.id}/context`)).json()
  ).messages.find((item) => item.id === editable.id);
  const editedPin = await context.request.patch(`${base}/api/rooms/general/messages/${editable.id}`, {
    data: { body: fresh.body + " latest pin edit", mentions: fresh.mentions },
    headers: { origin: base }
  });
  assert.ok(editedPin.ok());
  await expect(pinList).toContainText("latest pin edit");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    "Chat browser checks passed: native link menus, emoji insertion, duplicate-name mentions, cards, eight-kind ceiling, owner moderation, realtime, old pins, read cursors, phone geometry, Turkish controls, repeated-text edits, active identity updates and queued delivery."
  );
} finally {
  await browser?.close();
  await app.close();
}
