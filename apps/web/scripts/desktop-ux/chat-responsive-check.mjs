import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
try {
  for (const language of ["en", "tr"]) {
    for (const width of [320, 390, 560, 720, 900, 1180, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:1422/?mobile-shell&browser&${language}`);
      const field = page.locator("#messageInput");
      await expect(field).toBeVisible();
      for (const text of [
        "",
        "First line\nSecond line\nThird\nFourth\nFifth\nSixth",
        Array(30).fill("A long paragraph with words").join("\n")
      ]) {
        await field.fill(text);
        const geometry = await page.evaluate(() => {
          const field = document.querySelector("#messageInput");
          const emoji = document.querySelector(".chat-emoji-trigger");
          const send = document.querySelector(".composer-send");
          const box = (element) => {
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const style = getComputedStyle(field);
          return {
            field: box(field),
            emoji: box(emoji),
            send: box(send),
            scrolling: field.scrollHeight > field.clientHeight,
            overflow: style.overflowY,
            cap: parseFloat(style.lineHeight) * 6 + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2
          };
        });
        const { field: f, emoji: e, send: s } = geometry;
        assert(Math.abs(e.y - s.y) <= 1, JSON.stringify(geometry));
        assert.equal(e.width, 44);
        assert.equal(s.width, 44);
        assert.equal(e.height, 44);
        assert.equal(s.height, 44);
        assert(e.x >= f.x + 7 && e.x + e.width < s.x);
        assert(s.x + s.width <= f.x + f.width - 7);
        assert(f.height <= geometry.cap + 1);
        if (text.split("\n").length > 6) {
          assert(geometry.scrolling);
          assert.equal(geometry.overflow, "auto");
        }
        assert(f.x >= 0 && f.x + f.width <= width);
      }
      await page.locator(".chat-emoji-trigger").click();
      await expect(page.locator(".chat-dialog")).toBeVisible();
      await page.locator(".emoji-grid button").first().click();
      await expect(page.locator(".chat-dialog")).toHaveCount(0);
      await expect(field).toBeFocused();
      await field.fill("send test");
      await field.press("Enter");
      await expect(field).toHaveValue("");
      await field.pressSequentially("first");
      await field.press("Shift+Enter");
      await field.pressSequentially("second");
      await expect(field).toHaveValue("first\nsecond");
      await page.setViewportSize({ width, height: 390 });
      await field.fill(Array(20).fill("short landscape").join("\n"));
      assert((await field.boundingBox()).height <= 390 * 0.4 + 2);
      if (width === 390 && language === "en") await page.screenshot({ path: "/private/tmp/voxly-chat-responsive.png" });
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`${language} composer ${width}px passed`);
    }
    for (const width of [320, 390, 560, 720, 900, 1180, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 390 }, hasTouch: true });
      await page.goto(`http://127.0.0.1:1422/?browser&${language}`);
      await page.getByRole("button", { name: "account", exact: true }).click();
      await page.locator(".device-link-action").click();
      const dialog = page.locator(".link-dialog");
      await expect(dialog).toBeVisible();
      const reachable = async () => {
        const last = dialog.locator("button").last();
        await last.scrollIntoViewIfNeeded();
        const bounds = await dialog.boundingBox();
        const action = await last.boundingBox();
        assert(bounds.y >= 0 && bounds.y + bounds.height <= 391, JSON.stringify(bounds));
        assert(
          action.y >= bounds.y && action.y + action.height <= bounds.y + bounds.height + 1,
          JSON.stringify({ bounds, action })
        );
      };
      await reachable();
      await dialog.locator("button").last().click();
      await expect(dialog.locator(".link-code")).toHaveText("23456789AB");
      await reachable();
      await page.evaluate(() => {
        window.fixtureLinkWaiting = { confirmation: "123456", label: "A phone with a long translated name" };
      });
      await expect(dialog.locator(".link-confirmation")).toHaveText("123456");
      await reachable();
      await dialog.locator(".confirm-actions button").last().click();
      await expect(dialog.locator("button")).toHaveCount(1);
      await reachable();
      await dialog.locator("button").last().click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".device-link-action")).toBeFocused();
      if (width === 320) {
        await page.evaluate(() => {
          window.fixtureLinkError = true;
        });
        await page.locator(".device-link-action").click();
        await dialog.locator("button").last().click();
        await expect(dialog.locator(".device-error")).toBeVisible();
        await reachable();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(".settings-dialog")).toBeVisible();
        await expect(page.locator(".device-link-action")).toBeFocused();
      }
      await page.locator(".settings-version-link").click();
      await expect(page.locator(".settings-version-link")).toHaveText(language === "en" ? "About" : "Hakkında");
      await expect(page.locator(".settings-content")).toBeVisible();
      await page.close();
      console.log(`${language} Link Device ${width}px passed`);
    }
  }
} finally {
  await browser.close();
}
