/**
 * Optional landing-page analytics.
 *
 * Nothing loads unless the deployment configured a provider (see
 * `apps/server/src/analytics.ts`); a default self-hosted Voxly contacts no
 * analytics host at all. Even when configured, the script is fetched only while
 * the public landing page is mounted, and automatic route tracking stays off so
 * authenticated in-app paths — which contain server and room IDs — are never
 * reported.
 */

export interface AnalyticsSettings {
  provider: "umami" | "google";
  scriptUrl: string;
  websiteId: string;
}

interface UmamiApi {
  track(): void;
}

declare global {
  interface Window {
    umami?: UmamiApi;
    dataLayer?: unknown[];
  }
}

let providerScript: Promise<void> | null = null;
let loadedScriptUrl: string | null = null;

function loadScript(settings: AnalyticsSettings) {
  if (providerScript && loadedScriptUrl === settings.scriptUrl) {
    return providerScript;
  }

  loadedScriptUrl = settings.scriptUrl;
  providerScript = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = settings.scriptUrl;
    script.defer = true;
    if (settings.provider === "umami") {
      script.dataset.websiteId = settings.websiteId;
      // Umami otherwise patches history and would report every in-app path.
      script.dataset.autoTrack = "false";
    }
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("analytics_load_failed"));
    document.head.append(script);
  }).catch((error: unknown) => {
    providerScript = null;
    loadedScriptUrl = null;
    throw error;
  });

  return providerScript;
}

/**
 * gtag's bootstrap lives in the bundle rather than an inline `<script>`, so the
 * strict `script-src` policy needs no `'unsafe-inline'`. gtag.js identifies
 * commands by the `arguments` object the canonical snippet pushes, so forward
 * that rather than a plain array.
 */
const gtag = function () {
  (window.dataLayer ??= []).push(arguments);
} as (...params: unknown[]) => void;

/**
 * Records one landing-page view. A blocked, misconfigured, or unreachable
 * analytics host is not an application error, so failures are swallowed.
 */
export function trackLandingView(settings: AnalyticsSettings | null) {
  if (!settings) return;

  if (settings.provider === "google") {
    // Queue before loading, as Google's snippet does: gtag.js drains the
    // existing dataLayer on load. `config` sends the single page view; gtag
    // does not follow SPA navigation on its own.
    gtag("js", new Date());
    gtag("config", settings.websiteId);
    void loadScript(settings).catch(() => undefined);
    return;
  }

  void loadScript(settings).then(() => window.umami?.track()).catch(() => undefined);
}
