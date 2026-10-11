import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

// Start with: npm run dev:ux-check -w @voxly/web
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.audioLifecycle = { pauses: 0, attachments: 0 };
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (this.classList.contains("remote-audio")) window.audioLifecycle.pauses++;
      return pause.call(this);
    };
    const source = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      ...source,
      set(value) {
        if (this.classList.contains("remote-audio")) window.audioLifecycle.attachments++;
        source.set.call(this, value);
      }
    });
  });
  await page.goto("http://127.0.0.1:1422/hook-lifecycle.html");
  await page.waitForFunction(() => Boolean(window.hookFixture));

  // Navigation and new callbacks must not start another authentication lookup.
  await page.evaluate(() => window.hookFixture.mount("session"));
  await page.waitForFunction(() => window.hookFixture.calls.http["/api/me"] === 1);
  await page.evaluate(() => window.hookFixture.update({ route: { name: "invite", token: "fixture" } }));
  await page.evaluate(() => window.hookFixture.finishSession(401));
  await expect(page.locator("output")).toHaveText("ready");
  assert.deepEqual(await page.evaluate(() => window.hookFixture.calls.navigation), []);
  await page.evaluate(() =>
    window.hookFixture.update({ route: { name: "text", serverId: "server-a", roomId: "room-a" } })
  );
  assert.equal(await page.evaluate(() => window.hookFixture.calls.http["/api/me"]), 1);

  // Summary/nickname changes do not reload rooms.
  await page.evaluate(() => window.hookFixture.mount("workspace"));
  await expect(page.locator("output")).toHaveText("true");
  const roomRequests = await page.evaluate(() => window.hookFixture.calls.http["/api/servers/server-a/rooms"]);
  await page.evaluate(() => {
    window.hookFixture.workspace.applyAfkTimeout("server-a", 30);
    window.hookFixture.update({ user: { id: "self", nickname: "Renamed", role: "member", bannedAt: null } });
  });
  await expect(page.locator("output")).toHaveText("true");
  assert.equal(await page.evaluate(() => window.hookFixture.calls.http["/api/servers/server-a/rooms"]), roomRequests);

  // Volume and deafen update a persistent sink without pausing receiver media.
  await page.evaluate(() =>
    window.hookFixture.mount("audio", { stream: window.hookFixture.capture, muted: false, volume: 50 })
  );
  await page.waitForFunction(() => document.querySelector("audio")?.volume === 0.5);
  const initialAudio = await page.evaluate(() => ({ ...window.audioLifecycle }));
  await page.evaluate(() => window.hookFixture.update({ volume: 80, muted: true }));
  await page.waitForFunction(
    () => document.querySelector("audio")?.muted && document.querySelector("audio")?.volume === 0.8
  );
  assert.deepEqual(await page.evaluate(() => window.audioLifecycle), initialAudio);
  await page.evaluate(() => window.hookFixture.update({ stream: window.hookFixture.capture.clone() }));
  assert.equal(await page.evaluate(() => window.audioLifecycle.pauses), initialAudio.pauses + 1);
  await page.evaluate(() => window.hookFixture.unmount());
  assert.equal(await page.evaluate(() => window.hookFixture.capture.getAudioTracks()[0].readyState), "live");

  // Live gain/suppression and device scans never rejoin or reopen healthy capture.
  await page.evaluate(() => window.hookFixture.mount("voice"));
  await expect(page.locator("output")).toHaveText("idle");
  assert.equal(await page.evaluate(() => window.hookFixture.voice.join("room-a")), true);
  await expect(page.locator("output")).toHaveText("room-a");
  const voiceBaseline = await page.evaluate(() => ({
    captures: window.hookFixture.calls.captures,
    subscriptions: window.hookFixture.calls.subscriptions,
    joins: window.hookFixture.calls.emissions.filter((event) => event === "voice:join").length
  }));
  assert.equal(voiceBaseline.captures, 1);
  for (let revision = 1; revision <= 5; revision++) {
    await page.evaluate(
      (revision) =>
        window.hookFixture.update({
          microphoneVolume: 50 + revision,
          noiseSuppression: revision % 2 === 1,
          microphoneDeviceRevision: revision
        }),
      revision
    );
    await expect(page.locator("output")).toHaveText("room-a");
  }
  assert.deepEqual(
    await page.evaluate(() => ({
      captures: window.hookFixture.calls.captures,
      subscriptions: window.hookFixture.calls.subscriptions,
      joins: window.hookFixture.calls.emissions.filter((event) => event === "voice:join").length
    })),
    voiceBaseline
  );
  await page.evaluate(() => window.hookFixture.voice.leave());
  await expect(page.locator("output")).toHaveText("idle");

  // Rebuilding a LIVE source on each render must not duplicate pending work.
  await page.evaluate(() => window.hookFixture.mount("live"));
  await page.waitForFunction(() => window.hookFixture.calls.liveJoins === 1);
  for (let revision = 0; revision < 5; revision++) await page.evaluate(() => window.hookFixture.update({}));
  assert.equal(await page.evaluate(() => window.hookFixture.calls.liveJoins), 1);
  await page.evaluate(() => {
    window.hookFixture.finishLiveJoin();
    window.hookFixture.update({ activeVoiceRoomId: "room-a", voiceSnapshots: window.hookFixture.inVoiceSnapshot });
  });
  await page.waitForFunction(() => window.hookFixture.calls.liveSelections === 1);
  for (let revision = 0; revision < 5; revision++) await page.evaluate(() => window.hookFixture.update({}));
  assert.equal(await page.evaluate(() => window.hookFixture.calls.liveSelections), 1);
  await page.evaluate(() => window.hookFixture.finishLiveSelection());
  await page.waitForFunction(() => window.hookFixture.calls.handled === 1);

  // A new message preserves a reader's scroll position and exposes unread work.
  await page.evaluate(() => window.hookFixture.mount("chat", { messages: window.hookFixture.messages(40) }));
  assert.deepEqual(errors, []);
  await page.addStyleTag({
    content: ".message-list { height: 250px; min-height: 0; max-height: 250px; overflow: auto; flex: none; }"
  });
  const list = page.locator(".message-list");
  assert.ok(await list.evaluate((node) => node.scrollHeight > node.clientHeight + 48));
  await list.evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.evaluate(() => window.hookFixture.update({ messages: window.hookFixture.messages(41) }));
  await expect(page.locator(".new-messages-indicator")).toBeVisible();
  assert.equal(await list.evaluate((node) => node.scrollTop), 0);
  await page.evaluate(() =>
    window.hookFixture.update({
      currentRoom: { id: "room-b", serverId: "server-a", name: "Room B", kind: "text" },
      messages: window.hookFixture.messages(20)
    })
  );
  await expect(page.locator(".new-messages-indicator")).toHaveCount(0);
  assert.ok(await list.evaluate((node) => node.scrollTop > 0));

  assert.deepEqual(errors, []);
  console.log("Hook lifecycle checks passed: startup, membership, audio sinks, capture, LIVE and chat scrolling.");
} finally {
  await browser.close();
}
