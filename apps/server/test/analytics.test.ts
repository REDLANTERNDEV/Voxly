import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { analyticsCspOrigins, resolveAnalyticsConfig } from "../src/analytics.js";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";

describe("analytics configuration", () => {
  it("stays disabled when the operator sets nothing", () => {
    assert.equal(resolveAnalyticsConfig({}), undefined);
    assert.equal(resolveAnalyticsConfig({ provider: "  ", scriptUrl: "", websiteId: "" }), undefined);
    assert.deepEqual(analyticsCspOrigins(undefined), { script: [], connect: [] });
  });

  it("resolves a self-hosted Umami instance from its script URL and website ID", () => {
    const config = resolveAnalyticsConfig({
      provider: "Umami",
      scriptUrl: " https://analytics.example.com/script.js ",
      websiteId: " 451f26ee-726c-46f0-9643-2b302bef4a5f "
    });

    assert.deepEqual(config, {
      provider: "umami",
      scriptUrl: "https://analytics.example.com/script.js",
      websiteId: "451f26ee-726c-46f0-9643-2b302bef4a5f"
    });
  });

  it("derives the Google Analytics script URL from the measurement ID", () => {
    const config = resolveAnalyticsConfig({ provider: "google", websiteId: "G-TEST123" });

    assert.equal(config?.scriptUrl, "https://www.googletagmanager.com/gtag/js?id=G-TEST123");
    assert.equal(config?.websiteId, "G-TEST123");
  });

  it("fails loudly on a half-configured or unsupported provider", () => {
    assert.throws(() => resolveAnalyticsConfig({ websiteId: "abc" }), /ANALYTICS_PROVIDER/);
    assert.throws(() => resolveAnalyticsConfig({ provider: "plausible", websiteId: "abc" }), /Unsupported/);
    assert.throws(() => resolveAnalyticsConfig({ provider: "umami" }), /ANALYTICS_WEBSITE_ID/);
    assert.throws(() => resolveAnalyticsConfig({ provider: "umami", websiteId: "abc" }), /ANALYTICS_SCRIPT_URL/);
    assert.throws(() => resolveAnalyticsConfig({ provider: "umami", websiteId: "abc", scriptUrl: "script.js" }), /absolute URL/);
    assert.throws(() => resolveAnalyticsConfig({ provider: "umami", websiteId: "abc", scriptUrl: "javascript:alert(1)" }), /http or https/);
  });
});

describe("analytics in the public app config", () => {
  let app: VoxlyApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(analytics?: ReturnType<typeof resolveAnalyticsConfig>) {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: false,
      publicUrl: "https://voxly.example.com",
      analytics
    });
    return app;
  }

  it("reports no analytics for a default deployment", async () => {
    const server = await start();
    const response = await server.server.inject({ method: "GET", url: "/api/config" });

    assert.equal(response.json().analytics, null);
    assert.doesNotMatch(response.headers["content-security-policy"] as string, /analytics/);
  });

  it("publishes the configured provider to the browser and opens the policy for it", async () => {
    const server = await start(resolveAnalyticsConfig({
      provider: "umami",
      scriptUrl: "https://analytics.example.com/script.js",
      websiteId: "abc"
    }));
    const response = await server.server.inject({ method: "GET", url: "/api/config" });

    assert.deepEqual(response.json().analytics, {
      provider: "umami",
      scriptUrl: "https://analytics.example.com/script.js",
      websiteId: "abc"
    });
    assert.match(response.headers["content-security-policy"] as string, /script-src [^;]*https:\/\/analytics\.example\.com/);
  });
});
