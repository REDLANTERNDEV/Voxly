import assert from "node:assert/strict";

// Run with the documented CUA tab and viewport APIs against dev:ux-check.
// Collect independent failures so one broken surface does not hide another.
export async function checkSettingsInputs(tab, viewport, base = "http://127.0.0.1:1422") {
  const results = [];
  async function check(name, run) {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
    }
  }

  await viewport.set({ width: 1280, height: 800 });
  await tab.goto(`${base}/?browser&composer&windows`);
  await tab.getAXState({ emit: false });
  await check("composer padding focuses after selecting chat text", async () => {
    await tab.playwright.getByText("No messages here yet", { exact: true }).dblclick();
    await tab.getAXState({ emit: false });
    assert.ok(await tab.playwright.evaluate(() => window.getSelection()?.toString()));
    const point = await tab.playwright.locator(".composer").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return [r.left + 2, r.top + r.height / 2];
    });
    await tab.click(point);
    await tab.getAXState({ emit: false });
    assert.equal(await tab.playwright.evaluate(() => document.activeElement?.id), "messageInput");
  });
  await tab.playwright.getByRole("button", { name: "account", exact: true }).click();
  await tab.getAXState({ emit: false });
  await check("Account & devices stays on one navigation line with the Windows font", async () => {
    const geometry = await tab.playwright
      .locator('.settings-nav-item[aria-current="true"] > span:last-child')
      .evaluate((e) => ({
        height: e.getBoundingClientRect().height,
        line: getComputedStyle(e).lineHeight,
        fits: e.scrollWidth <= e.clientWidth
      }));
    assert.ok(geometry.height <= parseFloat(geometry.line) + 1, "Account & devices wraps in the settings navigation");
    assert.ok(geometry.fits, "Account & devices is clipped");
  });

  for (const query of ["browser&landing", "browser&landing&tr&light"]) {
    await tab.goto(`${base}/?${query}`);
    await tab.getAXState({ emit: false });
    await check(`language selector owns the entire visible box (${query})`, async () => {
      const covered = await tab.playwright.locator(".language-switch").evaluate((e) => {
        const r = e.getBoundingClientRect(),
          select = e.querySelector("select");
        return [
          [r.left + 0.5, r.top + r.height / 2],
          [r.right - 0.5, r.top + r.height / 2],
          [r.left + r.width / 2, r.top + 0.5],
          [r.left + r.width / 2, r.bottom - 0.5]
        ].every(([x, y]) => document.elementFromPoint(x, y) === select);
      });
      assert.ok(covered, "The language selector leaves a dead strip at its edges");
    });
  }
  await viewport.reset();
  return results;
}

export async function checkResponsiveSettingsInputs(tab, viewport, sizes, base = "http://127.0.0.1:1422") {
  const results = [];
  for (const size of sizes) {
    await viewport.set(size);
    for (const language of ["en", "tr"]) {
      const suffix = language === "tr" ? "&tr&light" : "";
      await tab.goto(`${base}/?browser&chat&windows${suffix}`);
      await tab.getAXState({ emit: false });
      const points = await tab.playwright.evaluate(() => {
        return [".composer", "#messageInput"].flatMap((selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          // Native pointer input rounds to whole pixels; stay inside the edge.
          return [
            [r.left + 1, r.top + r.height / 2],
            [r.right - 1, r.top + r.height / 2],
            [r.left + r.width / 2, r.top + 1],
            [r.left + r.width / 2, r.bottom - 1]
          ];
        });
      });
      for (const point of points) {
        await tab.playwright
          .getByText(language === "tr" ? "Burada henüz mesaj yok" : "No messages here yet", { exact: true })
          .dblclick();
        await tab.getAXState({ emit: false });
        await tab.click(point);
        await tab.getAXState({ emit: false });
        assert.equal(
          await tab.playwright.evaluate(() => document.activeElement?.id),
          "messageInput",
          `composer edge ${point} at ${size.width} / ${language}`
        );
      }
      await tab.playwright.locator("#messageInput").fill("A message");
      await tab.playwright.getByRole("button", { name: language === "tr" ? "Gönder" : "Send", exact: true }).click();
      await tab.getAXState({ emit: false });
      assert.equal(
        await tab.playwright.locator("#messageInput").evaluate((e) => e.value),
        "",
        "Send retains its submission action"
      );

      await tab.goto(`${base}/?browser&windows${suffix}`);
      await tab.getAXState({ emit: false });
      await tab.playwright.getByRole("button", { name: "account", exact: true }).click();
      await tab.getAXState({ emit: false });
      const geometry = await tab.playwright.locator(".settings-section-header").evaluate((e) => {
        const h = e.querySelector("h2").getBoundingClientRect(),
          close = e.querySelector("button").getBoundingClientRect();
        const nav = document.querySelector('.settings-nav-item[aria-current="true"] > span:last-child');
        return {
          fits: h.right <= close.left && h.left >= 0 && close.right <= innerWidth,
          closeWidth: close.width,
          closeHeight: close.height,
          labelHeight: nav.getBoundingClientRect().height,
          lineHeight: getComputedStyle(nav).lineHeight,
          navWidth: document.querySelector(".settings-nav").getBoundingClientRect().width
        };
      });
      assert.ok(geometry.fits, "Settings heading overlaps Close");
      assert.ok(geometry.closeWidth >= 44 && geometry.closeHeight >= 44, "Close retains its hit area");
      assert.ok(geometry.labelHeight <= parseFloat(geometry.lineHeight) + 1, "Account navigation title wraps");
      await tab.playwright
        .getByRole("button", { name: language === "tr" ? "Görünüm" : "Appearance", exact: true })
        .click();
      await tab.getAXState({ emit: false });
      assert.equal(
        await tab.playwright.locator(".settings-nav").evaluate((e) => e.getBoundingClientRect().width),
        geometry.navWidth,
        "Section changes must not shift the navigation width"
      );
      await tab.playwright.locator(".settings-dialog .language-preference > .label").click();
      await tab.getAXState({ emit: false });
      const edgesCovered = await tab.playwright.locator(".settings-dialog .language-switch").evaluate((e) => {
        const r = e.getBoundingClientRect(),
          select = e.querySelector("select");
        return [
          [r.left + 0.5, r.top + r.height / 2],
          [r.right - 0.5, r.top + r.height / 2],
          [r.left + r.width / 2, r.top + 0.5],
          [r.left + r.width / 2, r.bottom - 0.5]
        ].every(([x, y]) => document.elementFromPoint(x, y) === select);
      });
      assert.ok(edgesCovered, "Appearance uses the same full-box language selector");
      await tab.playwright
        .locator(".settings-dialog .language-switch select")
        .selectOption(language === "en" ? "tr" : "en");
      await tab.getAXState({ emit: false });
      assert.equal(
        await tab.playwright.locator(".settings-dialog .language-switch select").evaluate((e) => e.value),
        language === "en" ? "tr" : "en"
      );
      await tab.playwright.locator(".settings-close").press("Escape");
      await tab.getAXState({ emit: false });
      assert.equal(await tab.playwright.locator(".settings-dialog").count(), 0);
      results.push(
        `${size.width}×${size.height} / ${language}: composer edges, Send, settings titles, selector reuse and Escape`
      );
    }
  }
  await viewport.reset();
  return results;
}
