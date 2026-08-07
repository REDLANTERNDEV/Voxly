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
    // Such an instance ingests next to the script it served.
    assert.deepEqual(analyticsCspOrigins(config), {
      script: ["https://analytics.example.com"],
      connect: ["https://analytics.example.com"]
    });
  });

  it("allows the Umami Cloud ingest host, which is not the host serving the tag", () => {
    // Every regional tag host reports to the one gateway.
    for (const host of ["cloud.umami.is", "eu.umami.is", "us.umami.is", "analytics.umami.is"]) {
      const config = resolveAnalyticsConfig({ provider: "umami", scriptUrl: `https://${host}/script.js`, websiteId: "abc" });

      // The tracker has this endpoint compiled in. Allowing only the script
      // origin loads the tag and then blocks every event it posts.
      assert.deepEqual(analyticsCspOrigins(config), {
        script: [`https://${host}`],
        connect: ["https://gateway.umami.is"]
      });
    }
  });

  it("does not mistake a self-hosted lookalike domain for Umami Cloud", () => {
    const config = resolveAnalyticsConfig({
      provider: "umami",
      scriptUrl: "https://umami.is.example.com/script.js",
      websiteId: "abc"
    });

    assert.deepEqual(analyticsCspOrigins(config)?.connect, ["https://umami.is.example.com"]);
  });

  it("lets an operator point events at an instance separate from the script host", () => {
    const config = resolveAnalyticsConfig({
      provider: "umami",
      scriptUrl: "https://cdn.example.com/umami/script.js",
      websiteId: "abc",
      hostUrl: " https://analytics.example.com "
    });

    assert.equal(config?.hostUrl, "https://analytics.example.com/");
    assert.deepEqual(analyticsCspOrigins(config), {
      script: ["https://cdn.example.com"],
      connect: ["https://analytics.example.com"]
    });
  });

  it("lets an explicit host override the Umami Cloud default", () => {
    const config = resolveAnalyticsConfig({
      provider: "umami",
      scriptUrl: "https://cloud.umami.is/script.js",
      websiteId: "abc",
      hostUrl: "https://ingest.example.com"
    });

    assert.deepEqual(analyticsCspOrigins(config)?.connect, ["https://ingest.example.com"]);
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
    assert.throws(() => resolveAnalyticsConfig({ provider: "umami", websiteId: "abc", scriptUrl: "https://a.example/s.js", hostUrl: "analytics.example.com" }), /ANALYTICS_HOST_URL must be an absolute URL/);
    // A lone host URL is still a half-configuration rather than "disabled".
    assert.throws(() => resolveAnalyticsConfig({ hostUrl: "https://analytics.example.com" }), /ANALYTICS_PROVIDER/);
  });

  it("routes Google events to a server-side tagging container without closing off gtag's own", () => {
    const config = resolveAnalyticsConfig({ provider: "google", websiteId: "G-TEST123", hostUrl: "https://gtm.example.com" });
    const origins = analyticsCspOrigins(config);

    assert.equal(config?.hostUrl, "https://gtm.example.com/");
    assert.ok(origins.connect.includes("https://gtm.example.com"));
    // gtag has been observed bypassing transport_url; dropping these would make
    // those events disappear as quietly as the bug this guards against.
    assert.ok(origins.connect.includes("https://*.google-analytics.com"));
    assert.deepEqual(origins.script, ["https://www.googletagmanager.com"]);
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

  it("hands the browser the ingest host so the tracker does not have to guess it", async () => {
    const server = await start(resolveAnalyticsConfig({
      provider: "umami",
      scriptUrl: "https://cloud.umami.is/script.js",
      websiteId: "abc",
      hostUrl: "https://gateway.umami.is"
    }));
    const response = await server.server.inject({ method: "GET", url: "/api/config" });

    assert.equal(response.json().analytics.hostUrl, "https://gateway.umami.is/");
    assert.match(response.headers["content-security-policy"] as string, /connect-src [^;]*https:\/\/gateway\.umami\.is/);
  });
});
