/**
 * Whether the member has said they no longer need telling how linking works.
 *
 * A member who opens "Link a device" is holding a code and has no idea what to
 * do with it — the instruction lives on the *other* Device, which is the one
 * place the interface cannot reach. So the first time, it says where to go.
 *
 * Stored per browser rather than per account, deliberately. It is a note about
 * what this person has already read, not a fact about who they are, and the
 * one case where it would matter to scope it — a second member on a shared
 * machine — is a case where showing the guide again is the *right* outcome.
 */

const dismissedKey = "voxly:link-guide-dismissed:v1";

function browserStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readLinkGuideDismissed() {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    return storage.getItem(dismissedKey) === "true";
  } catch {
    return false;
  }
}

export function writeLinkGuideDismissed(dismissed: boolean) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (dismissed) storage.setItem(dismissedKey, "true");
    else storage.removeItem(dismissedKey);
  } catch {
    return;
  }
}

/**
 * The address to type on the other Device.
 *
 * Read from the running page rather than from configuration, because the
 * address that works is by definition the one the member is already on — a
 * configured public URL would be wrong for anybody testing over a local
 * network, which is exactly when this instruction matters most.
 */
export function linkAddress(origin = typeof window === "undefined" ? "" : window.location.origin) {
  return `${origin.replace(/\/+$/, "")}/link-device`;
}

/**
 * And where a Recovery code is spent. Said at the moment the code is shown,
 * because by the time a member needs it they will have no signed-in Device left
 * to look the address up from — which is the whole situation it exists for.
 */
/**
 * The address a scanned code opens: the link page, with the code in the
 * *fragment*.
 *
 * A fragment is never sent to the server and never appears in a referrer, which
 * is what makes this acceptable when the rest of ADR-0014 keeps codes out of
 * URLs. It is also the shape Voxly already uses for owner and access claims
 * (`#claim=`, `#token=`), so it is one pattern rather than a new one. The
 * arriving page strips it from history immediately, and the code it carries is
 * worth ninety seconds and one use either way.
 */
export function linkScanUrl(code: string, origin = typeof window === "undefined" ? "" : window.location.origin) {
  return `${linkAddress(origin)}#c=${encodeURIComponent(code.replace(/-/g, ""))}`;
}

export function readScannedLinkCode(hash: string) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return params.get("c") ?? "";
}

/**
 * The code this page was opened with, captured once when the module loads.
 *
 * Deliberately not read from `window.location` inside the component. React's
 * development double-mount runs the first mount, whose effect strips the
 * fragment out of history, and then mounts again — by which point the address
 * bar no longer has it, and a scanned code silently arrives empty. Reading at
 * import time happens before any of that, and "the code this page was opened
 * with" is a fact about the page load rather than about a render.
 */
const scannedOnLoad = typeof window === "undefined" ? "" : readScannedLinkCode(window.location.hash);

export function scannedLinkCode() {
  return scannedOnLoad;
}

export function recoverAddress(origin = typeof window === "undefined" ? "" : window.location.origin) {
  return `${origin.replace(/\/+$/, "")}/recover`;
}

const recoverGuideKey = "voxly:recover-guide-dismissed:v1";

export function readRecoverGuideDismissed() {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    return storage.getItem(recoverGuideKey) === "true";
  } catch {
    return false;
  }
}

export function writeRecoverGuideDismissed(dismissed: boolean) {
  const storage = browserStorage();
  if (!storage) return;
  try {
    if (dismissed) storage.setItem(recoverGuideKey, "true");
    else storage.removeItem(recoverGuideKey);
  } catch {
    return;
  }
}
