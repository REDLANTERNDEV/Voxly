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
