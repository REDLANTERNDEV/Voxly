import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {}),
  args: ["--autoplay-policy=no-user-gesture-required"]
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  const url = process.env.VOXLY_UX_URL ?? "http://127.0.0.1:1422/features.html";
  const bounds = async (selector) =>
    page.locator(selector).evaluate((node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    });
  const inViewport = async (selector) => {
    await expect
      .poll(async () => {
        const r = await bounds(selector),
          v = page.viewportSize();
        return r.x >= 7 && r.y >= 7 && r.right <= v.width - 7 && r.bottom <= v.height - 7;
      })
      .toBe(true);
    const r = await bounds(selector),
      v = page.viewportSize();
    assert.ok(r.x >= 7 && r.y >= 7 && r.right <= v.width - 7 && r.bottom <= v.height - 7, JSON.stringify({ r, v }));
    return r;
  };
  for (const viewport of [
    { width: 1200, height: 800 },
    { width: 680, height: 360 },
    { width: 360, height: 260 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.getByRole("button", { name: "Open menu" }).waitFor();
    for (const point of [
      { x: 20, y: 20 },
      { x: viewport.width - 10, y: 20 },
      { x: viewport.width - 10, y: viewport.height - 10 },
      { x: 20, y: viewport.height - 10 }
    ]) {
      console.log("Checking", viewport, point);
      await page.mouse.click(point.x, point.y, { button: "right" });
      await page.getByRole("dialog", { name: "Actions" }).waitFor();
      const root = await inViewport(".sidebar-context-menu");
      await page.getByRole("button", { name: "Move to", exact: true }).hover();
      await page.getByRole("menu", { name: "Move to" }).waitFor();
      const submenu = await inViewport(".menu-submenu-panel");
      if (viewport.width === 1200) {
        if (point.x < 100) assert.ok(submenu.x >= root.right, JSON.stringify({ root, submenu, point }));
        else assert.ok(submenu.right <= root.x, JSON.stringify({ root, submenu, point }));
      }
      await page.getByRole("menuitem", { name: "Voice room 1", exact: true }).click();
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto(url);
  await page.getByRole("button", { name: "Open menu" }).waitFor();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Open menu" }).evaluate((node) => node === document.activeElement),
    true
  );
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Move to" }).click();
  await page.setViewportSize({ width: 400, height: 300 });
  await inViewport(".menu-submenu-panel");
  await page.mouse.click(350, 280);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menu").waitFor();
  await expect(page.getByRole("menuitem", { name: "Voice room 1", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const touch = await browser.newContext({ viewport: { width: 390, height: 360 }, hasTouch: true, isMobile: true });
  const mobile = await touch.newPage();
  await mobile.goto(url);
  await mobile.getByRole("button", { name: "Open menu" }).waitFor();
  await mobile.getByRole("button", { name: "Open menu" }).tap();
  await mobile.getByRole("button", { name: "Move to" }).tap();
  await mobile.getByRole("menuitem", { name: "Voice room 1", exact: true }).tap();
  assert.equal(await mobile.getByRole("dialog").count(), 0);
  await touch.close();
  await page.locator(".screen-connection-warning button").hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.locator(".screen-connection-warning button").focus();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Move to", exact: true }).hover();
  await page.getByRole("menu").waitFor();
  assert.equal(await page.getByRole("menu").evaluate((node) => document.fullscreenElement.contains(node)), true);
  await inViewport(".menu-submenu-panel");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.exitFullscreen());
  assert.deepEqual(errors, []);
  console.log("Menu checks passed: all edges, narrow/short windows, resize, selection, keyboard, touch.");
  if (process.env.VOXLY_SCREEN_BENCHMARK === "1") {
    await page.goto(url);
    await page.getByRole("button", { name: "Open menu" }).waitFor();
    const report = await page.evaluate(() => window.screenBenchmark(60));
    await writeFile("/private/tmp/voxly-screen-benchmark.json", JSON.stringify(report, null, 2));
    for (const result of report) {
      assert.ok(result.samples.some((sample) => sample.receivedHeight > 0));
      console.log(
        result.mode,
        "first received 720p:",
        result.first720pMs,
        "ms",
        "final profile:",
        result.samples.at(-1).profile
      );
    }
  }
} finally {
  await browser.close();
}
