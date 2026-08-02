/**
 * Response security headers applied to every route.
 *
 * These are set at the application layer on purpose. Voxly is self-hosted
 * behind whatever proxy the operator already runs — host Nginx, host Caddy, or
 * a container-managed proxy such as Traefik under a PaaS — and each of those
 * would otherwise need its own copy of this policy. Setting them here means
 * every deployment path gets an identical posture.
 */

/**
 * Origins embedded in `<iframe>` by the chat client.
 *
 * Keep in sync with the providers in `apps/web/src/lib/messageEmbeds.ts` and
 * with the `embedKey` provider pattern in `app.ts`. A provider that is missing
 * here is silently blocked by the browser rather than failing loudly.
 */
const embedFrameOrigins = [
  "https://www.youtube-nocookie.com",
  "https://platform.twitter.com",
  "https://player.vimeo.com",
  "https://open.spotify.com"
];

/** Cloudflare Turnstile loads its script and renders its widget in an iframe. */
const turnstileOrigin = "https://challenges.cloudflare.com";

export function contentSecurityPolicyDirectives(options: { upgradeInsecureRequests: boolean }) {
  return {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "form-action": ["'self'"],
    // The app is never meant to be framed; this is the modern clickjacking guard.
    "frame-ancestors": ["'none'"],
    "script-src": ["'self'", turnstileOrigin],
    // React style props render as inline style attributes, which style-src governs.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    // Socket.IO negotiates over HTTP then upgrades to a WebSocket on the same origin.
    "connect-src": ["'self'", "ws:", "wss:", turnstileOrigin],
    // WebRTC tracks are attached via srcObject and are not CSP-governed, but
    // locally recorded or buffered media uses blob: URLs.
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'", turnstileOrigin, ...embedFrameOrigins],
    // Only meaningful once the deployment actually serves HTTPS. Enabling it on
    // a plain-HTTP evaluation host would break same-origin subresource loads.
    ...(options.upgradeInsecureRequests ? { "upgrade-insecure-requests": [] } : {})
  };
}

export function helmetOptions(options: { https: boolean }) {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: contentSecurityPolicyDirectives({ upgradeInsecureRequests: options.https })
    },
    // Only send HSTS when the deployment is actually HTTPS. Sending it over
    // plain HTTP is ignored by browsers, but sending it from a local HTTP
    // evaluation host that later shares a hostname would pin the browser.
    strictTransportSecurity: options.https
      ? { maxAge: 31536000, includeSubDomains: true }
      : false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" as const },
    // Voxly serves its own SPA and API from one origin; isolating it from
    // cross-origin embedding is safe and blocks a class of side-channel reads.
    crossOriginOpenerPolicy: { policy: "same-origin" as const },
    // Third-party embeds (YouTube, Spotify) are cross-origin subresources, so
    // require-corp would break them. `cross-origin` keeps our own assets
    // readable by those frames without weakening the app itself.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" as const },
    // X-Frame-Options is redundant with frame-ancestors on modern browsers but
    // still respected by older ones.
    frameguard: { action: "deny" as const },
    xPoweredBy: false
  };
}
