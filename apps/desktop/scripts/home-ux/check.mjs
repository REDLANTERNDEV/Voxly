import assert from "node:assert/strict";
export async function checkHomeMenus(tab, viewport, base = "http://127.0.0.1:1423") {
  await viewport.reset();
  await tab.goto(base);
  const row = tab.playwright.locator(".saved-installation").filter({ hasText: "Acme Crew" });
  await row.locator("summary").click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.getByRole("menuitem", { name: "Remove default: Acme Crew", exact: true }).isVisible(), true);
  assert.equal(
    await row.locator(".installation-menu").evaluate((e) => {
      const trigger = e.querySelector("summary").getBoundingClientRect(),
        menu = e.querySelector("[role=menu]").getBoundingClientRect();
      return menu.bottom <= trigger.top && menu.left >= 0 && menu.right <= innerWidth && menu.top >= 0;
    }),
    true
  );
  await row.getByRole("menuitem", { name: "Remove default: Acme Crew", exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.getByText("Default", { exact: true }).count(), 0);
  assert.equal(await tab.playwright.locator("#open-startup").evaluate((e) => e.checked), false);
  assert.equal(await tab.playwright.locator(".saved-installation").count(), 3);
  await row.locator("summary").press("ArrowUp");
  await tab.getAXState({ emit: false });
  assert.equal(
    await tab.playwright.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Forget address: Acme Crew"
  );
  await row.getByRole("menuitem", { name: "Forget address: Acme Crew", exact: true }).press("Escape");
  await tab.getAXState({ emit: false });
  assert.equal(await row.locator("details").getAttribute("open"), null);
  await row.locator("summary").click();
  await tab.getAXState({ emit: false });
  await tab.playwright.locator(".home-title").click();
  await tab.getAXState({ emit: false });
  assert.equal(await row.locator("details").getAttribute("open"), null);
  await viewport.set({ width: 380, height: 520 });
  const last = tab.playwright.locator(".saved-installation").filter({ hasText: "Dev Sandbox" });
  await last.locator("summary").click();
  await tab.getAXState({ emit: false });
  assert.equal(
    await last.locator("[role=menu]").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
    true
  );
  await last.getByRole("menuitem", { name: "Make default: Dev Sandbox", exact: true }).click();
  await tab.getAXState({ emit: false });
  assert.equal(await last.getByText("Default", { exact: true }).isVisible(), true);
  await viewport.reset();
  return [
    "actual Home markup: Remove default retains addresses and disables startup",
    "menus above, viewport clamping, keyboard navigation, Escape and outside dismissal",
    "narrow Home: Make default and keyboard focus retained"
  ];
}
