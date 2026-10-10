import { useCallback, useEffect, useRef, useState } from "react";
import type { Translate } from "../app/types.js";
import {
  answerDesktopAuthorization,
  cancelDesktopLaunch,
  createDesktopLaunch,
  fetchDesktopAuthorization,
  fetchDesktopLaunch
} from "../api.js";
import { DesktopLaunchDialog } from "./DesktopLaunchDialog.js";
import { DesktopLaunchPreparation, type PreparedDesktopLaunch } from "../lib/desktopLaunchPreparation.js";
import { desktopOpenLink } from "../lib/desktopLinks.js";

/** Launch ids are public correlation only. Approval never travels in the URI. */
export function OpenInDesktop({ t, authenticated = false }: { t: Translate; authenticated?: boolean }) {
  const [launch, setLaunch] = useState<PreparedDesktopLaunch | null>(null);
  const [waiting, setWaiting] = useState<{
    id: string;
    confirmation: string;
    label: string;
    origin: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"waiting" | "approved" | "failed" | "continue" | "expired">("waiting");
  const [showing, setShowing] = useState(false);
  const preparation = useRef<DesktopLaunchPreparation | null>(null);
  if (!preparation.current)
    preparation.current = new DesktopLaunchPreparation(createDesktopLaunch, cancelDesktopLaunch);
  const [preparing, setPreparing] = useState(true);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const mounted = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const href =
    typeof window === "undefined"
      ? null
      : desktopOpenLink(window.location.origin, window.__VOXLY_DESKTOP_V1__?.version === 1, launch?.id);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      preparation.current?.clear();
    };
  }, []);

  const prepare = useCallback(async () => {
    setPreparing(true);
    setPrepareFailed(false);
    try {
      const next = await preparation.current!.prepare();
      if (mounted.current) {
        if (next) setLaunch(next);
        else setPrepareFailed(true);
      }
    } catch {
      if (mounted.current) setPrepareFailed(true);
    } finally {
      if (mounted.current) setPreparing(false);
    }
  }, []);
  useEffect(() => {
    if (!authenticated || !href || waiting || (showing && outcome === "waiting") || outcome === "approved") return;
    if (!launch) {
      void prepare();
      return;
    }
    const refresh = () => {
      if (Date.now() < launch.expiresAt) return;
      preparation.current!.clear();
      setLaunch(null);
    };
    const timer = window.setTimeout(refresh, Math.max(0, launch.expiresAt - Date.now()));
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [authenticated, Boolean(href), showing, outcome, waiting, launch, prepare]);

  useEffect(() => {
    if (!showing || !launch || outcome !== "waiting" || waiting) return;
    let live = true;
    let timer = 0;
    const deadline = launch.expiresAt;
    const poll = async () => {
      if (Date.now() >= deadline) {
        if (live) {
          setOutcome("continue");
          preparation.current!.clear();
          setLaunch(null);
        }
        return;
      }
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
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [showing, launch, outcome, waiting]);

  useEffect(() => {
    if (waiting) cancelButton.current?.focus();
  }, [waiting]);
  useEffect(() => {
    if (!waiting || outcome === "approved") return;
    const timeout = window.setTimeout(
      () => {
        preparation.current!.clear();
        setLaunch(null);
        setWaiting(null);
        setOutcome("expired");
      },
      Math.max(0, Date.parse(waiting.expiresAt) - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [waiting, outcome]);

  const cancel = () => {
    if (busy) return;
    preparation.current!.clear(outcome === "approved");
    setShowing(false);
    setLaunch(null);
    setOutcome("waiting");
    setWaiting(null);
    opener.current?.focus();
  };

  // Invoke directly from the click so the browser retains user activation.
  const start = () => {
    if (busy || !launch || !href) return;
    if (Date.now() >= launch.expiresAt) {
      preparation.current!.clear();
      setLaunch(null);
      setOutcome("continue");
      return;
    }
    setShowing(true);
    setOutcome("waiting");
    setWaiting(null);
    window.location.assign(href);
  };

  const approve = async () => {
    if (!waiting || busy) return;
    setBusy(true);
    try {
      await answerDesktopAuthorization(waiting.id, true);
      if (mounted.current) {
        preparation.current!.clear(true);
        setOutcome("approved");
        setWaiting(null);
      }
    } catch {
      if (mounted.current) setOutcome("failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!href) return null;
  if (!authenticated)
    return (
      <a className="btn btn-ghost" href={href} title={t("desktop.openHint")}>
        {t("desktop.open")}
      </a>
    );
  return (
    <>
      <button
        ref={opener}
        className="btn btn-ghost"
        type="button"
        disabled={busy || preparing || !launch || showing}
        onClick={start}
      >
        {t("desktop.open")}
      </button>
      {prepareFailed ? (
        <p className="small" role="alert">
          {t("desktopSignIn.failed")}{" "}
          <button type="button" className="btn btn-ghost" onClick={() => void prepare()}>
            {t("common.retry")}
          </button>
        </p>
      ) : null}
      {showing ? (
        <DesktopLaunchDialog
          title={t(waiting && outcome === "waiting" ? "desktopSignIn.approvalTitle" : "desktop.open")}
          onCancel={cancel}
        >
          <p className="desktop-launch-origin">{waiting?.origin ?? window.location.origin}</p>
          {outcome === "approved" ? (
            <p role="status">{t("desktopSignIn.approved")}</p>
          ) : outcome === "failed" ? (
            <p role="alert">{t("desktopSignIn.failed")}</p>
          ) : outcome === "expired" ? (
            <p role="alert">{t("desktopSignIn.expiredBrowser")}</p>
          ) : waiting ? (
            <>
              <p>{t("desktopSignIn.approvalCopy", { account: launch?.account ?? "", device: waiting.label })}</p>
              <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>
                {waiting.confirmation}
              </span>
              <p className="muted small">{t("link.confirmationHint")}</p>
            </>
          ) : (
            <p role="status">{t("desktopSignIn.launchWaiting")}</p>
          )}
          <div className="confirm-actions">
            <button ref={cancelButton} className="btn btn-ghost" type="button" disabled={busy} onClick={cancel}>
              {t(outcome === "approved" || outcome === "continue" || !waiting ? "common.done" : "common.cancel")}
            </button>
            {waiting && (outcome === "waiting" || outcome === "failed") ? (
              <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void approve()}>
                {t(outcome === "failed" ? "common.retry" : "link.approve")}
              </button>
            ) : null}
            {!waiting && outcome !== "approved" ? (
              <button type="button" className="btn btn-primary" disabled={preparing || !launch} onClick={start}>
                {t("common.retry")}
              </button>
            ) : null}
            {!waiting && outcome !== "approved" ? (
              <a
                className="btn btn-ghost"
                href="https://github.com/REDLANTERNDEV/Voxly/releases"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("desktop.download")}
              </a>
            ) : null}
          </div>
        </DesktopLaunchDialog>
      ) : null}
    </>
  );
}
