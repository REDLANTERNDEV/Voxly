/**
 * The optional Cloudflare Turnstile challenge: the operator's configuration,
 * and the verification an unauthenticated caller has to pass.
 *
 * Only one route asks — invite acceptance by someone who has no session yet,
 * which is the single endpoint that mints an account for a stranger. The
 * config and the check that reads it belong together; the route group is
 * handed the config through its `RouteContext` (`http.ts`) rather than the
 * whole option bag.
 *
 * A failed lookup, an unreachable Cloudflare, or a hostname that does not
 * match all answer the same way: not verified. There is no state in which a
 * missing answer is treated as a passing one.
 */

import { z } from "zod";

export interface TurnstileConfig {
  enabled: true;
  siteKey: string;
  secretKey: string;
  expectedHostname?: string;
}

export function resolveTurnstileConfig(input: { siteKey?: string; secretKey?: string; publicUrl?: string }): TurnstileConfig | undefined {
  const siteKey = input.siteKey?.trim();
  const secretKey = input.secretKey?.trim();

  if (!siteKey && !secretKey) {
    return undefined;
  }

  if (!siteKey || !secretKey) {
    throw new Error("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set together.");
  }

  const expectedHostname = resolveHostname(input.publicUrl);
  return expectedHostname
    ? { enabled: true, siteKey, secretKey, expectedHostname }
    : { enabled: true, siteKey, secretKey };
}

function resolveHostname(publicUrl: string | undefined) {
  if (!publicUrl) return undefined;
  try {
    return new URL(publicUrl).hostname;
  } catch {
    return undefined;
  }
}

export async function verifyTurnstile(secretKey: string, token: string | undefined, expectedHostname?: string) {
  if (!token) {
    return false;
  }

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: secretKey,
        response: token
      })
    });
    if (!response.ok) {
      return false;
    }
    const result = z.object({ success: z.boolean(), hostname: z.string().optional() }).parse(await response.json());
    return result.success && (!expectedHostname || result.hostname === expectedHostname);
  } catch {
    return false;
  }
}
