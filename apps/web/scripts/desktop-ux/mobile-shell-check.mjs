import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
try {
  for (const language of ["en", "tr"])
    for (const width of [320, 390, 560, 900]) {
      const page = await browser.newPage({
        viewport: { width, height: width === 560 ? 390 : 844 },
        hasTouch: true,
        reducedMotion: "reduce"
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:1422/?mobile-shell&browser&${language}`);
      await expect(page.locator(".mobile-topbar")).toBeVisible();
      await expect(page.locator("body > #root > .voice-dock")).toBeHidden();
      await page.locator(".mobile-topbar button").first().click();
      await expect(page.locator(".drawer-voice-status .account-menu")).toBeVisible();
      await page.locator(".drawer-download").scrollIntoViewIfNeeded();
      const download = await page.locator(".drawer-download").boundingBox();
      assert(download.width >= 100 && download.x >= 0 && download.x + download.width <= width && download.height >= 44);
      assert.equal(await page.locator(".workspace-server > .sidebar-menu-trigger").count(), 0);
      await page.locator(".mobile-server-menu").click();
      await expect(page.locator(".context-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".mobile-server-menu")).toBeFocused();
      await page.locator(".drawer-voice-status summary").click();
      await expect(page.locator(".drawer-voice-status .account-settings-link")).toBeVisible();
      await page.locator(".drawer-voice-status summary").click();
      await page.evaluate(() => window.fixtureJoin());
      await page.locator(".workspace-drawer-close").click();
      await expect(page.locator("body > #root > .voice-dock")).toBeVisible();
      await expect(page.locator("body > #root > .voice-dock > .dock-self")).toBeHidden();
      const bounds = await page.locator("body > #root > .voice-dock").boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.locator(".composer textarea").focus();
      await page.setViewportSize({ width, height: 390 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const composer = await page.locator(".composer").boundingBox();
      const dock = await page.locator("body > #root > .voice-dock").boundingBox();
      await page.screenshot({ path: "/private/tmp/voxly-mobile-call.png" });
      assert(composer.y + composer.height <= dock.y + 1, JSON.stringify({ width, language, composer, dock }));
      if (width === 390 && language === "en") await page.screenshot({ path: "/private/tmp/voxly-mobile-call.png" });
      assert.equal(errors.length, 0, errors.join("\n"));
      console.log(`${language} ${width}px passed`);
      await page.close();
    }
} finally {
  await browser.close();
}
