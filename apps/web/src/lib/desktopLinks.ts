/** App-opening links carry the Installation origin and optionally a public sign-in correlation id. */
export function desktopOpenLink(origin: string, insideDesktop = false, launchId?: string): string | null {
  // eslint-disable-next-line no-control-regex -- Reject C0/DEL characters in untrusted origins.
  if (insideDesktop || origin.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(origin)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    ["tauri.localhost", "ipc.localhost"].includes(url.hostname)
  )
    return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (launchId && !desktopLaunchId(launchId)) return null;
  return `voxly://open?origin=${encodeURIComponent(origin)}${launchId ? `&launch=${launchId}` : ""}`;
}

export function desktopLaunchId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function desktopLaunchFromSearch(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("desktopLaunch");
  return values.length === 1 && desktopLaunchId(values[0]!) ? values[0] : undefined;
}
