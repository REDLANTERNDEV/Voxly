import { useCallback, useEffect, useRef, useState } from "react";
import { fetchConfig } from "../api.js";

export const clientUpdatePollMs = 5 * 60_000;
const clientUpdateAttemptKey = "voxly:client-update";

export function loadedClientVersion(page: Document, baseUrl: string) {
  const script = page.querySelector<HTMLScriptElement>('script[type="module"][src]');
  if (!script) return null;
  try {
    const url = new URL(script.src, baseUrl);
    return url.origin === new URL(baseUrl).origin ? url.pathname : null;
  } catch {
    return null;
  }
}

export function clientUpdateRequired(current: string | null, latest: string | null) {
  return Boolean(current && latest && current !== latest);
}

export function clientUpdateDisposition(current: string | null, latest: string | null, mediaBusy: boolean, alreadyPending: boolean) {
  if (!clientUpdateRequired(current, latest)) return "none";
  return mediaBusy || alreadyPending ? "defer" : "reload";
}

export function clientUpdateUrl(currentUrl: string, latest: string) {
  const url = new URL(currentUrl);
  url.searchParams.set("voxly-client", latest);
  return url.href;
}

export function claimClientUpdateAttempt(storage: Pick<Storage, "getItem" | "setItem">, current: string, latest: string) {
  const transition = `${current}->${latest}`;
  if (storage.getItem(clientUpdateAttemptKey) === transition) return false;
  storage.setItem(clientUpdateAttemptKey, transition);
  return true;
}

/**
 * An installed window can stay alive for weeks, so navigation is the update
 * boundary rather than waiting for the member to close it. A deployment must
 * never interrupt live media. Once deferred, keep the update explicit even
 * after the call ends instead of surprising the member on the next poll.
 */
export function useClientUpdate(latestAtStartup: string | null, mediaBusy = false) {
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const pendingRef = useRef<string | null>(null);
  const busyRef = useRef(mediaBusy);
  busyRef.current = mediaBusy;
  const reloadWhenSafe = useCallback(() => {
    if (busyRef.current || !pendingRef.current) return;
    window.location.replace(clientUpdateUrl(window.location.href, pendingRef.current));
  }, []);
  useEffect(() => {
    const current = loadedClientVersion(document, window.location.href);
    const apply = (latest: string | null) => {
      const disposition = clientUpdateDisposition(current, latest, busyRef.current, pendingRef.current !== null);
      if (disposition === "none" && current && latest === current) {
        // A deployment rollback can make an earlier pending version obsolete.
        pendingRef.current = null;
        setPendingVersion(null);
      }
      if (disposition === "defer") {
        pendingRef.current = latest;
        setPendingVersion(latest);
        return false;
      }
      if (disposition === "reload") {
        try {
          if (!claimClientUpdateAttempt(window.sessionStorage, current as string, latest as string)) return false;
        } catch {
          // Storage can be unavailable in a locked-down browser. A versioned
          // navigation still has a better chance of updating than doing none.
        }
        window.location.replace(clientUpdateUrl(window.location.href, latest as string));
        return true;
      }
      return false;
    };

    if (apply(latestAtStartup)) return;

    let disposed = false;
    let checking = false;
    const check = async () => {
      if (disposed || checking || !navigator.onLine) return;
      checking = true;
      try {
        const config = await fetchConfig({ cache: "no-store" });
        if (!disposed) apply(config.clientVersion);
      } catch {
        // A failed check says nothing about the deployed version. Retry later.
      } finally {
        checking = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = window.setInterval(() => void check(), clientUpdatePollMs);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [latestAtStartup]);
  return { pendingVersion, reloadWhenSafe };
}
