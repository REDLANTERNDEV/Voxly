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
 *
 * Whatever the shape, a provider is *two* origins rather than one: the host the
 * tag is fetched from, and the host it posts events to. They coincide often
 * enough to look like one — a self-hosted Umami is both — but every provider
 * separates them somewhere, and the tag decides the second one itself. Both
 * supported providers also let a deployment move it: Umami through
 * `data-host-url`, GA4 through the `transport_url` of a server-side tagging
 * container.
 *
 * Resolving only the first origin fails silently, which is the trap this module
 * exists to avoid: the tag loads, the deployment looks correct, and the browser
 * discards every event against a policy that never named the second host. Any
 * provider added here must therefore declare where its events go, not just
 * where its script lives.
 */

export type AnalyticsProvider = "umami" | "google";

export interface AnalyticsConfig {
  provider: AnalyticsProvider;
  /** Absolute URL of the provider script the landing page loads. */
  scriptUrl: string;
  /** Umami website ID, or the Google Analytics measurement ID. */
  websiteId: string;
  /**
   * Where events are posted, when the deployment moved them off the provider's
   * own endpoint. Sent to the browser, which hands it to the tag in whichever
   * form that provider expects.
   */
  hostUrl?: string;
}

const googleScriptOrigin = "https://www.googletagmanager.com";

/**
 * Collection endpoints GA4 uses. Regional endpoints (`region1.` and friends)
 * are assigned per property, so the wildcard forms are required.
 */
const googleIngestOrigins = [
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  googleScriptOrigin
];

/**
 * Umami Cloud serves the tag from one host and ingests events on another, which
 * the tracker has compiled in rather than derived from its own script URL.
 *
 * Every regional tag host (`cloud`, `eu`, `us`, `analytics`) reports to the one
 * gateway, so the whole zone is matched rather than a list that goes stale when
 * a region is added. Self-hosted instances sit on the operator's own domain and
 * ingest next to the script they served.
 */
const umamiCloudZone = "umami.is";
const umamiCloudIngestOrigin = "https://gateway.umami.is";

/**
 * Where each provider's events go, which is the half a script URL cannot tell
 * you. Adding a provider means adding a row here; leaving one out produces a
 * deployment that loads its tag and silently records nothing.
 *
 * `exclusive` says whether a configured host is the tag's only destination.
 * Umami resolves exactly one endpoint and honours `data-host-url` above its own
 * guess, so a configured host replaces the default. gtag.js is not that
 * disciplined — tags outside the GA4 config have been observed ignoring
 * `transport_url` — so its own endpoints stay allowed alongside, since the cost
 * of a redundant origin is far lower than that of silently dropped events.
 */
const providerIngest: Record<AnalyticsProvider, { defaults(scriptUrl: string): string[]; exclusive: boolean }> = {
  umami: {
    defaults(scriptUrl) {
      const { hostname, origin } = new URL(scriptUrl);
      const cloud = hostname === umamiCloudZone || hostname.endsWith(`.${umamiCloudZone}`);
      return [cloud ? umamiCloudIngestOrigin : origin];
    },
    exclusive: true
  },
  google: {
    defaults: () => googleIngestOrigins,
    exclusive: false
  }
};

export function resolveAnalyticsConfig(input: { provider?: string; scriptUrl?: string; websiteId?: string; hostUrl?: string }): AnalyticsConfig | undefined {
  const provider = input.provider?.trim().toLowerCase();
  const scriptUrl = input.scriptUrl?.trim();
  const websiteId = input.websiteId?.trim();
  const hostUrl = input.hostUrl?.trim();

  if (!provider && !scriptUrl && !websiteId && !hostUrl) {
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

  // Resolved once here so every consumer — the policy, the browser — reads the
  // same pair of origins rather than re-deriving one of them.
  const ingest = hostUrl ? { hostUrl: requireHttpUrl(hostUrl, "ANALYTICS_HOST_URL") } : {};

  if (provider === "google") {
    // gtag.js is served from one well-known origin and keyed by measurement ID,
    // so operators only supply the ID.
    return { provider, scriptUrl: `${googleScriptOrigin}/gtag/js?id=${encodeURIComponent(websiteId)}`, websiteId, ...ingest };
  }

  if (!scriptUrl) {
    throw new Error("ANALYTICS_SCRIPT_URL must be set for the umami provider, for example https://analytics.example.com/script.js");
  }
  return { provider, scriptUrl: requireHttpUrl(scriptUrl, "ANALYTICS_SCRIPT_URL"), websiteId, ...ingest };
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

  const ingest = providerIngest[analytics.provider];
  const configured = analytics.hostUrl ? [new URL(analytics.hostUrl).origin] : [];
  // A configured host stands alone only where the tag has no other endpoint to
  // fall back to; elsewhere it is added to the provider's own.
  const connect = configured.length > 0 && ingest.exclusive
    ? configured
    : [...configured, ...ingest.defaults(analytics.scriptUrl)];

  return { script: [new URL(analytics.scriptUrl).origin], connect: [...new Set(connect)] };
}

function requireHttpUrl(value: string, name: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL, received "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http or https, received "${value}".`);
  }
  return parsed.toString();
}
