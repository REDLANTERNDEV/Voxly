import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolveAnalyticsConfig } from "../src/analytics.js";
import { createVoxlyApp, type VoxlyApp } from "../src/app.js";
import { contentSecurityPolicyDirectives } from "../src/security.js";

describe("response security headers", () => {
  let app: VoxlyApp | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(overrides: { secureCookies?: boolean } = {}) {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: overrides.secureCookies ?? false,
      publicUrl: "https://voxly.example.com"
    });
    return app;
  }

  it("sends a content security policy and clickjacking guards on every response", async () => {
    const server = await start();
    const response = await server.server.inject({ method: "GET", url: "/api/health" });

    assert.equal(response.statusCode, 200);
    const csp = response.headers["content-security-policy"];
    assert.ok(typeof csp === "string" && csp.length > 0, "expected a CSP header");
    assert.match(csp as string, /frame-ancestors 'none'/);
    assert.match(csp as string, /object-src 'none'/);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
  });

  it("allows the embed and Turnstile origins the client actually loads", () => {
    const directives = contentSecurityPolicyDirectives({ upgradeInsecureRequests: false });

    // Mirrors apps/web/src/lib/messageEmbeds.ts; a provider missing here is
    // blocked silently by the browser rather than failing a test elsewhere.
    for (const origin of [
      "https://www.youtube-nocookie.com",
      "https://platform.twitter.com",
      "https://player.vimeo.com",
      "https://open.spotify.com"
    ]) {
      assert.ok(directives["frame-src"].includes(origin), `frame-src must allow ${origin}`);
    }

    assert.ok(directives["script-src"].includes("https://challenges.cloudflare.com"));
    assert.ok(directives["frame-src"].includes("https://challenges.cloudflare.com"));
    // Socket.IO upgrades to a WebSocket on the same origin.
    assert.ok(directives["connect-src"].includes("wss:"));
    // The production bundle emits no inline <script>, so this must stay strict.
    assert.ok(!directives["script-src"].includes("'unsafe-inline'"));
  });

  it("keeps the policy free of analytics origins when no provider is configured", () => {
    const directives = contentSecurityPolicyDirectives({ upgradeInsecureRequests: false });

    assert.deepEqual(directives["script-src"], ["'self'", "https://challenges.cloudflare.com"]);
    assert.deepEqual(directives["connect-src"], ["'self'", "ws:", "wss:", "https://challenges.cloudflare.com"]);
  });

  it("allows only the configured analytics origin", () => {
    const directives = contentSecurityPolicyDirectives({
      upgradeInsecureRequests: false,
      analytics: { provider: "umami", scriptUrl: "https://analytics.example.com/script.js", websiteId: "abc" }
    });

    assert.ok(directives["script-src"].includes("https://analytics.example.com"));
    assert.ok(directives["connect-src"].includes("https://analytics.example.com"));
    // The script path is not an origin and would silently invalidate the source.
    assert.ok(!directives["script-src"].includes("https://analytics.example.com/script.js"));
  });

  it("allows the Umami ingest host as well as the host serving the tag", () => {
    const directives = contentSecurityPolicyDirectives({
      upgradeInsecureRequests: false,
      analytics: resolveAnalyticsConfig({ provider: "umami", scriptUrl: "https://cloud.umami.is/script.js", websiteId: "abc" })
    });

    assert.ok(directives["script-src"].includes("https://cloud.umami.is"));
    // Without this the tag loads and every event it posts is dropped.
    assert.ok(directives["connect-src"].includes("https://gateway.umami.is"));
  });

  it("allows the Google Analytics script and its regional collection endpoints", () => {
    const directives = contentSecurityPolicyDirectives({
      upgradeInsecureRequests: false,
      analytics: resolveAnalyticsConfig({ provider: "google", websiteId: "G-TEST123" })
    });

    assert.ok(directives["script-src"].includes("https://www.googletagmanager.com"));
    assert.ok(directives["connect-src"].includes("https://*.google-analytics.com"));
    assert.ok(directives["connect-src"].includes("https://*.analytics.google.com"));
  });

  it("withholds HSTS and upgrade-insecure-requests from plain-HTTP deployments", async () => {
    const server = await start({ secureCookies: false });
    const response = await server.server.inject({ method: "GET", url: "/api/health" });

    assert.equal(response.headers["strict-transport-security"], undefined);
    assert.doesNotMatch(response.headers["content-security-policy"] as string, /upgrade-insecure-requests/);
  });

  it("sends HSTS once the deployment serves HTTPS", async () => {
    const server = await start({ secureCookies: true });
    const response = await server.server.inject({ method: "GET", url: "/api/health" });

    assert.match(response.headers["strict-transport-security"] as string, /max-age=31536000/);
    assert.match(response.headers["content-security-policy"] as string, /upgrade-insecure-requests/);
  });
});

describe("health endpoint", () => {
  let app: VoxlyApp;

  afterEach(async () => {
    await app.close();
  });

  it("reports readiness without a session and without touching auth routes", async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: false,
      publicUrl: "https://voxly.example.com"
    });

    const response = await app.server.inject({ method: "GET", url: "/api/health" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  });
});

describe("rate limiting", () => {
  let app: VoxlyApp;

  afterEach(async () => {
    await app.close();
  });

  it("throttles repeated unauthenticated invite attempts from one client", async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: false,
      publicUrl: "https://voxly.example.com"
    });

    const attempt = () => app.server.inject({
      method: "POST",
      url: "/api/invites/preview",
      remoteAddress: "203.0.113.10",
      payload: { inviteToken: "definitely-not-a-real-token" }
    });

    const statuses: number[] = [];
    for (let index = 0; index < 25; index += 1) {
      statuses.push((await attempt()).statusCode);
    }

    assert.ok(statuses.includes(429), "expected the limiter to reject a burst of attempts");
    assert.equal(statuses.filter((status) => status !== 429).length, 20, "expected 20 attempts through the limiter");
  });

  it("does not rate limit reads, so an idle client is never locked out of the app shell", async () => {
    app = await createVoxlyApp({
      databasePath: ":memory:",
      secureCookies: false,
      publicUrl: "https://voxly.example.com"
    });

    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      statuses.push((await app.server.inject({
        method: "GET",
        url: "/api/config",
        remoteAddress: "203.0.113.11"
      })).statusCode);
    }

    assert.ok(!statuses.includes(429), "GET /api/config must not be throttled");
  });
});
