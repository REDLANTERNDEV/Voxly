import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:1422/?windows");
  await page.getByRole("button", { name: "shortcuts", exact: true }).click();
  const row = page.locator(".desktop-shortcut-row").first();
  for (const modifier of ["Control", "Alt", "Shift"]) {
    await row.getByRole("button", { name: "Edit keybind", exact: true }).click();
    await row.getByRole("textbox").press(modifier);
    await expect(row.getByRole("button", { name: "Stop recording", exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Stop recording", exact: true }).click();
    const operations = JSON.parse(await page.locator("#desktop-operation-log").textContent());
    assert.equal(operations.findLast((o) => o.kind === "shortcut").binding, modifier + "Left");
  }
  let operations;
  await row.getByRole("button", { name: "Edit keybind", exact: true }).click();
  await row.getByRole("textbox").press("Control");
  await row.getByRole("textbox").press("Control+Shift+K");
  await row.getByRole("button", { name: "Stop recording", exact: true }).click();
  operations = JSON.parse(await page.locator("#desktop-operation-log").textContent());
  assert.equal(operations.findLast((o) => o.kind === "shortcut").binding, "ControlLeft+ShiftLeft+KeyK");
  assert.deepEqual(operations.filter((o) => o.kind === "recording").at(-1), { kind: "recording", enabled: false });
  for (const index of [0, 1, 2, 3]) {
    const actionRow = page.locator(".desktop-shortcut-row").nth(index);
    await actionRow.getByRole("button", { name: "Edit keybind", exact: true }).click();
    await page.keyboard.down("ControlRight");
    await page.keyboard.press("KeyM");
    await page.keyboard.up("ControlRight");
    await actionRow.getByRole("button", { name: "Stop recording", exact: true }).click();
    const operations = JSON.parse(await page.locator("#desktop-operation-log").textContent());
    assert.equal(operations.findLast((o) => o.kind === "shortcut").binding, "ControlRight+KeyM");
  }
  console.log("Ctrl, Alt, and Shift alone save; longer Ctrl chords remain recordable.");
} finally {
  await browser.close();
}
