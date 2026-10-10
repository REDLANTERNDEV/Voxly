import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.VOXLY_TEST_BROWSER_PATH ? { executablePath: process.env.VOXLY_TEST_BROWSER_PATH } : {})
});
try {
  for (const scanned of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const requests = [];
    let approve = false;
    let refuseFirst = !scanned;
    await page.route("**/api/devices/links/claim", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const accepted = Boolean(body.turnstileToken) && !refuseFirst;
      refuseFirst = false;
      await route.fulfill({
        status: accepted ? 200 : 400,
        json: accepted ? { claimToken: "fixture-claim", confirmation: "123456" } : { error: "turnstile_failed" }
      });
    });
    await page.route("**/api/devices/links/collect", (route) =>
      route.fulfill({ json: { status: approve ? (scanned ? "approved" : "refused") : "pending" } })
    );
    await page.goto(`http://127.0.0.1:1422/features.html${scanned ? "#c=23456789AB" : ""}`);
    const source = await (await page.request.get("http://127.0.0.1:1422/features.jsx")).text();
    const reactUrl = source.match(/from "([^"]*\/react\.js[^"]*)"/)[1];
    const rootUrl = source.match(/from "([^"]*\/react-dom_client\.js[^"]*)"/)[1];
    await page.evaluate(
      async ({ reactUrl, rootUrl, screenUrl, translateUrl }) => {
        window.turnstile = {
          render: (_, options) => {
            window.challenge = options;
            window.challengeRenders = (window.challengeRenders ?? 0) + 1;
            return "fixture-widget";
          },
          remove() {}
        };
        const React = (await import(reactUrl)).default;
        const { createRoot } = (await import(rootUrl)).default;
        const { LinkDeviceScreen } = await import(screenUrl);
        const { translate } = await import(translateUrl);
        const host = document.createElement("div");
        document.body.replaceChildren(host);
        createRoot(host).render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(LinkDeviceScreen, {
              language: "en",
              t: (key, values) => translate("en", key, values),
              onLanguageChange() {},
              onLinked: () => {
                window.linked = true;
              },
              turnstileSiteKey: "fixture-key"
            })
          )
        );
      },
      {
        reactUrl,
        rootUrl,
        screenUrl: "/@fs" + new URL("../../src/features/auth/LinkDeviceScreen.tsx", import.meta.url).pathname,
        translateUrl: "/@fs" + new URL("../../src/lib/i18n.ts", import.meta.url).pathname
      }
    );
    await page.waitForFunction(() => Boolean(window.challenge));
    if (!scanned) await page.locator("[name=linkCode]").fill("2345-678-9AB");
    await expect(page.locator("[name=linkCode]")).toHaveValue("2345-678-9AB");
    assert.equal(new URL(page.url()).hash, "");
    await page.evaluate(() => window.challenge.callback("fixture-expired"));
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await page.evaluate(() => window.challenge["expired-callback"]());
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    const challengeRenders = await page.evaluate(() => window.challengeRenders);
    await page.evaluate(() => window.challenge.callback("fixture-verified"));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    if (!scanned) {
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
      await page.waitForFunction((before) => window.challengeRenders > before, challengeRenders);
      await page.evaluate(() => window.challenge.callback("fixture-retry"));
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      assert.equal(requests[1].turnstileToken, "fixture-retry");
    }
    await expect(page.locator(".link-confirmation")).toHaveText("123456");
    assert.equal(requests[0].code, "2345-678-9AB");
    assert.equal(requests[0].turnstileToken, "fixture-verified");
    approve = true;
    if (scanned) await page.waitForFunction(() => window.linked === true);
    else {
      await expect(page.getByRole("button", { name: "Try another code", exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => Boolean(window.linked)), false);
    }
    await page.close();
  }
  console.log(
    "Device linking passed: scanned/typed codes, StrictMode, challenge expiry, current token, failed-claim reset/retry, approval and refusal."
  );
} finally {
  await browser.close();
}
