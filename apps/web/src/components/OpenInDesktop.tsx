import { useEffect, useRef, useState } from "react";
import type { Translate } from "../app/types.js";
import { answerDesktopAuthorization, cancelDesktopLaunch, createDesktopLaunch, fetchDesktopAuthorization, fetchDesktopLaunch } from "../api.js";
import { desktopOpenLink } from "../lib/desktopLinks.js";

/** Launch ids are public correlation only. Approval never travels in the URI. */
export function OpenInDesktop({ t, authenticated = false }: { t: Translate; authenticated?: boolean }) {
  const [launch, setLaunch] = useState<{ id: string; account: string } | null>(null);
  const [waiting, setWaiting] = useState<{ id: string; confirmation: string; label: string; origin: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"waiting" | "approved" | "failed">("waiting");
  const current = useRef<string | null>(null);
  const mounted = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const href = typeof window === "undefined" ? null
    : desktopOpenLink(window.location.origin, window.__VOXLY_DESKTOP_V1__?.version === 1, launch?.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (current.current) void cancelDesktopLaunch(current.current).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!launch || outcome !== "waiting" || waiting) return;
    let live = true;
    let timer = 0;
    const deadline = Date.now() + 180_000;
    const poll = async () => {
      if (Date.now() >= deadline) { if (live) setOutcome("failed"); return; }
      try {
        const response = await fetchDesktopLaunch(launch.id);
        if (!live) return;
        if (response.authorizationId) {
          const request = await fetchDesktopAuthorization(response.authorizationId);
          if (live) setWaiting({ id: response.authorizationId, ...request });
          return;
        }
      } catch {
        // Retry transient errors; the bounded request expires on the server.
      }
      if (live) timer = window.setTimeout(() => void poll(), 2500);
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { live = false; window.clearTimeout(timer); };
  }, [launch, outcome, waiting]);

  useEffect(() => { if (waiting) cancelButton.current?.focus(); }, [waiting]);

  const cancel = () => {
    if (busy) return;
    const id = current.current;
    current.current = null;
    setLaunch(null);
    setWaiting(null);
    if (id) void cancelDesktopLaunch(id).catch(() => undefined);
    opener.current?.focus();
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setOutcome("waiting");
    try {
      const created = await createDesktopLaunch();
      if (!mounted.current) {
        void cancelDesktopLaunch(created.id).catch(() => undefined);
        return;
      }
      current.current = created.id;
      setLaunch(created);
      const link = desktopOpenLink(window.location.origin, false, created.id);
      if (link) window.location.assign(link);
    } catch {
      if (mounted.current) setOutcome("failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const approve = async () => {
    if (!waiting || busy) return;
    setBusy(true);
    try {
      await answerDesktopAuthorization(waiting.id, true);
      if (mounted.current) { current.current = null; setOutcome("approved"); setWaiting(null); }
    } catch {
      if (mounted.current) setOutcome("failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!href) return null;
  if (!authenticated) return <a className="btn btn-ghost" href={href} title={t("desktop.openHint")}>{t("desktop.open")}</a>;
  return <>
    <button ref={opener} className="btn btn-ghost" type="button" disabled={busy || Boolean(launch)} onClick={() => void start()}>{t("desktop.open")}</button>
    {launch ? <section className="link-panel" aria-live="polite">
      {outcome === "approved" ? <p role="status">{t("desktopSignIn.approved")}</p>
        : outcome === "failed" ? <p role="alert">{t("desktopSignIn.failed")}</p>
          : waiting ? <>
            <strong>{t("desktopSignIn.approvalTitle")}</strong>
            <p>{t("desktopSignIn.approvalCopy", { account: launch.account, device: waiting.label })}</p>
            <p className="muted small">{waiting.origin}</p>
            <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>{waiting.confirmation}</span>
            <p className="muted small">{t("link.confirmationHint")}</p>
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void approve()}>{t("link.approve")}</button>
          </> : <>
            <p role="status">{t("desktopSignIn.launchWaiting")}</p>
            <a className="btn btn-ghost" href={href}>{t("desktop.open")}</a>
          </>}
      <button ref={cancelButton} className="btn btn-ghost" type="button" disabled={busy} onClick={cancel}>{t(outcome === "approved" ? "common.done" : "common.cancel")}</button>
    </section> : outcome === "failed" ? <p role="alert">{t("desktopSignIn.failed")}</p> : null}
  </>;
}
