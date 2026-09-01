/**
 * A name a member can tell their own Devices apart by, and nothing more.
 *
 * The raw `User-Agent` is a fingerprint: version numbers, build identifiers,
 * engine strings and sometimes the device model. Storing it would be a real
 * privacy cost for a member-facing list whose entire job is to answer "is that
 * one mine?" — and "Chrome on Windows" answers that as well as the full string
 * does. So the string is reduced on the way in and the original is never kept.
 *
 * Deliberately coarse in the other direction too: no version, so a browser
 * update does not make a member's own Device look like a stranger's.
 */

/** Order matters. Edge, Opera and Samsung Internet all also say "Chrome". */
const browsers: readonly (readonly [string, RegExp])[] = [
  ["Edge", /\bEdg(?:e|A|iOS)?\//],
  ["Opera", /\bOPR\/|\bOpera\//],
  ["Samsung Internet", /\bSamsungBrowser\//],
  ["Firefox", /\bFirefox\/|\bFxiOS\//],
  ["Chrome", /\bChrome\/|\bCriOS\//],
  // Last, because every browser above also claims to be Safari.
  ["Safari", /\bSafari\//]
];

/** Also order-sensitive: an iPhone's string contains "Mac OS X". */
const platforms: readonly (readonly [string, RegExp])[] = [
  ["iPhone", /\biPhone\b/],
  ["iPad", /\biPad\b/],
  ["Android", /\bAndroid\b/],
  ["ChromeOS", /\bCrOS\b/],
  ["Windows", /\bWindows\b/],
  ["macOS", /\bMacintosh\b|\bMac OS X\b/],
  ["Linux", /\bLinux\b|\bX11\b/]
];

function match(candidates: readonly (readonly [string, RegExp])[], userAgent: string) {
  for (const [name, pattern] of candidates) {
    if (pattern.test(userAgent)) return name;
  }
  return "";
}

/**
 * Never throws and never returns an empty string. A Device with no usable
 * `User-Agent` still has to appear in the list — an unnamed row a member can
 * sign out is far better than a Device they cannot see at all.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const source = typeof userAgent === "string" ? userAgent.slice(0, 512) : "";
  const browser = match(browsers, source);
  const platform = match(platforms, source);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || "Unknown device";
}
