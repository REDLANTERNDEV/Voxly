import { resolveAnalyticsConfig } from "./analytics.js";
import { createVoxlyApp } from "./app.js";
import { createRtcConfigProvider } from "./rtcConfig.js";
import { resolveTurnstileConfig } from "./turnstile.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";

/**
 * Keep a single faulty request or socket frame from ending every user's session.
 *
 * Voice, presence, and visual-subscription state live in process memory, so an
 * exit drops every active call. Node's default for both of these is to terminate,
 * which turned individually minor bugs into a whole-deployment outage. Log and
 * keep serving instead; a handler that throws has already been isolated by the
 * per-request and per-socket guards in `app.ts`.
 */
process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

const app = await createVoxlyApp({
  databasePath: process.env.DATABASE_PATH ?? "./voxly.sqlite",
  publicUrl: process.env.VOXLY_PUBLIC_URL,
  ownerBootstrapToken: process.env.OWNER_BOOTSTRAP_TOKEN,
  allowHttpOwnerBootstrap: process.env.ENABLE_HTTP_OWNER_BOOTSTRAP === "true",
  secureCookies: resolveSecureCookies(),
  trustProxy: process.env.TRUST_PROXY !== "false",
  logger: process.env.VOXLY_LOG !== "false",
  webDistPath: process.env.WEB_DIST_PATH,
  turnstile: resolveTurnstileConfig({
    siteKey: process.env.TURNSTILE_SITE_KEY,
    secretKey: process.env.TURNSTILE_SECRET_KEY,
    publicUrl: process.env.VOXLY_PUBLIC_URL
  }),
  analytics: resolveAnalyticsConfig({
    provider: process.env.ANALYTICS_PROVIDER,
    scriptUrl: process.env.ANALYTICS_SCRIPT_URL,
    websiteId: process.env.ANALYTICS_WEBSITE_ID
  }),
  rtc: createRtcConfigProvider(process.env)
});

await app.server.listen({ host, port });

function resolveSecureCookies() {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;

  if (process.env.VOXLY_PUBLIC_URL) {
    try {
      return new URL(process.env.VOXLY_PUBLIC_URL).protocol === "https:";
    } catch {
      return process.env.NODE_ENV === "production";
    }
  }

  return process.env.NODE_ENV === "production";
}
