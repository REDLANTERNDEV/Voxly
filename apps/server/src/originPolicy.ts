/**
 * Which callers count as the installation itself.
 *
 * SameSite=Lax stops a cross-site page from riding the session cookie, but a
 * page on a sibling subdomain is same-site and Lax lets it through. A browser
 * names the page behind every write and every WebSocket handshake in `Origin`,
 * so when the operator has said what the installation's origin is
 * (`VOXLY_PUBLIC_URL`), anything else naming itself there is refused.
 *
 * A request with no Origin is not a browser page: the Music bot and the CLIs
 * are Node clients, and a browser's own same-origin read may omit it. Those
 * pass, and the cookie rule below covers the browser half of that.
 */

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginPolicy {
  /** False for a write whose Origin is present and is not the installation's. */
  allowsRequest: (method: string, origin: string | undefined) => boolean;
  /** False for a realtime handshake whose Origin is present and is not the installation's. */
  allowsHandshake: (origin: string | undefined) => boolean;
}

export function createOriginPolicy(publicUrl: string | null | undefined): OriginPolicy {
  const expected = installationOrigin(publicUrl);
  const allows = (origin: string | undefined) => expected === null || origin === undefined || origin === expected;
  return {
    allowsRequest: (method, origin) => safeMethods.has(method.toUpperCase()) || allows(origin),
    allowsHandshake: allows
  };
}

function installationOrigin(publicUrl: string | null | undefined) {
  if (!publicUrl?.trim()) return null;
  try {
    return new URL(publicUrl.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a request came from a browser page. Browsers send `Origin` on writes
 * and handshakes and `Sec-Fetch-Site` on everything; Node's fetch and
 * socket.io-client send neither, which is how the Music bot looks.
 */
export function isBrowserRequest(headers: Record<string, string | string[] | undefined>) {
  return headers.origin !== undefined || headers["sec-fetch-site"] !== undefined;
}
