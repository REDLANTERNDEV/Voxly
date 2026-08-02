/**
 * Optional landing-page analytics.
 *
 * Voxly is self-hosted, so analytics are an operator choice rather than a
 * property of the project: nothing is sent anywhere unless the deployment
 * configures a provider. The browser only loads the provider script on the
 * public landing page, and the client never reports authenticated in-app paths.
 *
 * Two provider shapes are supported because they bootstrap differently:
 * a Umami-style tag (script plus `data-website-id`) and Google Analytics
 * (gtag.js, configured from the bundle rather than an inline snippet, so the
 * strict `script-src` policy stays intact).
 */

export type AnalyticsProvider = "umami" | "google";

export interface AnalyticsConfig {
  provider: AnalyticsProvider;
  /** Absolute URL of the provider script the landing page loads. */
  scriptUrl: string;
  /** Umami website ID, or the Google Analytics measurement ID. */
  websiteId: string;
}

const googleScriptOrigin = "https://www.googletagmanager.com";

/**
 * Collection endpoints GA4 uses. Regional endpoints (`region1.` and friends)
 * are assigned per property, so the wildcard forms are required.
 */
const googleConnectOrigins = [
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  googleScriptOrigin
];

export function resolveAnalyticsConfig(input: { provider?: string; scriptUrl?: string; websiteId?: string }): AnalyticsConfig | undefined {
  const provider = input.provider?.trim().toLowerCase();
  const scriptUrl = input.scriptUrl?.trim();
  const websiteId = input.websiteId?.trim();

  if (!provider && !scriptUrl && !websiteId) {
    return undefined;
  }
  if (!provider) {
    throw new Error("ANALYTICS_PROVIDER must be set to \"umami\" or \"google\" when analytics values are configured.");
  }
  if (provider !== "umami" && provider !== "google") {
    throw new Error(`Unsupported ANALYTICS_PROVIDER "${provider}". Supported values are "umami" and "google".`);
  }
  if (!websiteId) {
    throw new Error("ANALYTICS_WEBSITE_ID must be set when ANALYTICS_PROVIDER is set.");
  }

  if (provider === "google") {
    // gtag.js is served from one well-known origin and keyed by measurement ID,
    // so operators only supply the ID.
    return { provider, scriptUrl: `${googleScriptOrigin}/gtag/js?id=${encodeURIComponent(websiteId)}`, websiteId };
  }

  if (!scriptUrl) {
    throw new Error("ANALYTICS_SCRIPT_URL must be set for the umami provider, for example https://analytics.example.com/script.js");
  }
  return { provider, scriptUrl: requireHttpUrl(scriptUrl), websiteId };
}

/**
 * Origins the landing page must be allowed to load the provider script from and
 * report to. Returns empty lists when analytics are disabled, which keeps the
 * default policy exactly as strict as it was before this option existed.
 */
export function analyticsCspOrigins(analytics: AnalyticsConfig | undefined) {
  if (!analytics) {
    return { script: [] as string[], connect: [] as string[] };
  }
  if (analytics.provider === "google") {
    return { script: [googleScriptOrigin], connect: googleConnectOrigins };
  }

  // A Umami instance receives its events on the same origin that serves the
  // script, so one origin covers both directives.
  const origin = new URL(analytics.scriptUrl).origin;
  return { script: [origin], connect: [origin] };
}

function requireHttpUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`ANALYTICS_SCRIPT_URL must be an absolute URL, received "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`ANALYTICS_SCRIPT_URL must use http or https, received "${value}".`);
  }
  return parsed.toString();
}
