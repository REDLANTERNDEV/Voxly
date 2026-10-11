import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
async function expectTopStatus(fixture, text) {
  const status = fixture.locator("[role=status]");
  await expect(status).toHaveText(text);
  const bounds = await fixture.boundingBox();
  const label = await status.boundingBox();
  assert.ok(bounds && label);
  assert.ok(Math.abs(label.y - bounds.y - 12) < 1, "status stays at the top of the share area");
  assert.ok(Math.abs(label.x + label.width / 2 - bounds.x - bounds.width / 2) < 1);
  assert.ok(label.y + label.height < bounds.y + bounds.height / 2, "status leaves the picture centre clear");
  assert.equal(await status.evaluate((element) => getComputedStyle(element).pointerEvents), "none");
}
try {
  for (const frameCallbacks of [true, false]) {
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 500 },
      { width: 390, height: 844 },
      { width: 1280, height: 800, hasTouch: true }
    ]) {
      const { hasTouch = false, ...size } = viewport;
      const page = await browser.newPage({ viewport: size, hasTouch });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (!frameCallbacks)
        await page.addInitScript(() => {
          HTMLVideoElement.prototype.requestVideoFrameCallback = undefined;
        });
      await page.goto("http://127.0.0.1:1422/features.html");
      await page.waitForFunction(() => Boolean(window.screenRecoveryFixture));
      const fixture = page.locator("#recovery-fixture");
      await page.evaluate(() => window.screenRecoveryFixture.watch());
      await expectTopStatus(fixture, "Connecting…");
      await expect(fixture.locator(".screen-stage-placeholder")).toHaveCount(0);
      await page.evaluate(() => window.screenRecoveryFixture.language("tr"));
      await expectTopStatus(fixture, "Bağlanıyor…");
      await page.evaluate(() => window.screenRecoveryFixture.language("en"));
      await page.evaluate(() => window.screenRecoveryFixture.tick(10000));
      await expectTopStatus(fixture, "Connecting…");
      await page.evaluate(() => window.screenRecoveryFixture.start());
      await expect(fixture.locator("video")).toBeVisible();
      await page.waitForFunction(() => window.screenRecoveryFixture.status() === "ready");
      await page.waitForFunction(() => {
        const canvas = document.querySelector("#recovery-fixture canvas");
        const pixel = canvas.getContext("2d").getImageData(100, 100, 1, 1).data;
        return pixel[0] > 240 && pixel[1] < 10 && pixel[2] < 10;
      });
      await page.evaluate(() => window.screenRecoveryFixture.disconnect());
      await expect(fixture.locator("canvas")).toBeVisible();
      await expect(fixture.locator(".screen-stage-placeholder")).toHaveCount(0);
      await expect(fixture.locator("[role=status]")).toHaveCount(0);
      const picture = await fixture.locator("canvas").evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        pixel: Array.from(canvas.getContext("2d").getImageData(100, 100, 1, 1).data)
      }));
      assert.equal(picture.width, 1280);
      assert.equal(picture.height, 720);
      assert.ok(picture.pixel[0] > 240 && picture.pixel[1] < 10 && picture.pixel[2] < 10);
      await page.evaluate(() => window.screenRecoveryFixture.tick(14999));
      await expect(fixture.locator("[role=status]")).toHaveCount(0);
      await page.evaluate(() => window.screenRecoveryFixture.disconnect());
      await page.evaluate(() => window.screenRecoveryFixture.tick(15000));
      await expectTopStatus(fixture, "Reconnecting…");
      await page.evaluate(() => window.screenRecoveryFixture.language("tr"));
      await expectTopStatus(fixture, "Yeniden bağlanıyor…");
      await page.evaluate(() => window.screenRecoveryFixture.start("#0000ff"));
      await expect(fixture.locator("video")).toBeVisible();
      await expect(fixture.locator("canvas")).toBeHidden();
      await expect(fixture.locator("[role=status]")).toHaveCount(0);
      await page.evaluate(() => window.screenRecoveryFixture.unwatch());
      await expect(fixture.locator("canvas")).toHaveCount(0);
      await expect(fixture.locator("video")).toHaveCount(0);
      assert.deepEqual(errors, []);
      console.log(
        `Top connecting/reconnecting labels in both languages; retained picture and recovery preserved; ${size.width}x${size.height}, touch=${hasTouch}, frame callbacks=${frameCallbacks}.`
      );
      await page.close();
    }
  }
} finally {
  await browser.close();
}
