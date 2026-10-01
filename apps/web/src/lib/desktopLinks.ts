/** App-opening links carry only the current Installation origin. */
export function desktopOpenLink(origin: string, insideDesktop = false): string | null {
  if (insideDesktop || origin.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(origin)) return null;
  let url: URL;
  try { url = new URL(origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password
    || ["tauri.localhost", "ipc.localhost"].includes(url.hostname)) return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return `voxly://open?origin=${encodeURIComponent(origin)}`;
}
