import { AuthEntryFrame } from "./AuthEntryFrame.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "@voxly/shared";
import {
  answerDesktopAuthorization,
  cancelDesktopAuthorization,
  collectDesktopAuthorization,
  createDesktopAuthorization,
  fetchDesktopAuthorization,
  type DesktopAuthorization
} from "../../api.js";
import type { Translate } from "../../app/types.js";
import { rememberCompletedDesktopAuthentication } from "../../lib/desktopSettings.js";
import { desktopLaunchFromSearch } from "../../lib/desktopLinks.js";
import { createDesktopApprovalWindow } from "../../lib/desktopApprovalWindow.js";
import type { LanguageCode } from "../../lib/i18n.js";

/** The private collection secret lives only in this desktop webview's memory. */
export function DesktopBrowserSignIn({ t, onLinked }: { t: Translate; onLinked: () => void }) {
  const [launchId] = useState(() => desktopLaunchFromSearch(window.location.search));
  const automaticStarted = useRef(false);
  const [usingLaunch, setUsingLaunch] = useState(false);
  const [request, setRequest] = useState<DesktopAuthorization | null>(null);
  const current = useRef<DesktopAuthorization | null>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const approvalWindow = useRef<ReturnType<typeof createDesktopApprovalWindow> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [outcome, setOutcome] = useState<"pending" | "refused" | "expired">("pending");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = current.current;
      if (pending) void cancelDesktopAuthorization(pending.id, pending.secret).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!request || outcome !== "pending") return;
    let live = true;
    const requestRevision = revision.current;
    let timeout = 0;
    let delay = 1500;
    const deadline = Date.now() + request.expiresInSeconds * 1000;
    const poll = async () => {
      if (Date.now() >= deadline) {
        void approvalWindow.current?.restore();
        current.current = null; setOutcome("expired"); return;
      }
      try {
        const response = await collectDesktopAuthorization(request.id, request.secret);
        if (!live || revision.current !== requestRevision || current.current !== request) return;
        if (response.status === "approved") {
          current.current = null;
          await rememberCompletedDesktopAuthentication(window, response.status, () => live && revision.current === requestRevision);
          if (!live || revision.current !== requestRevision) return;
          await approvalWindow.current?.restore();
          if (!live || revision.current !== requestRevision) return;
          onLinked();
          return;
        }
        if (response.status !== "pending") {
          void approvalWindow.current?.restore();
          current.current = null;
          setOutcome(response.status);
          return;
        }
      } catch {
        // A transient network failure should not consume the request.
      }
      if (live) {
        delay = Math.min(delay + 750, 5000);
        timeout = window.setTimeout(() => void poll(), delay);
      }
    };
    timeout = window.setTimeout(() => void poll(), delay);
    return () => { live = false; window.clearTimeout(timeout); };
  }, [request, outcome, onLinked]);

  const start = useCallback(async (automaticLaunchId?: string) => {
    const startingRevision = ++revision.current;
    setBusy(true);
    setError(false);
    setUsingLaunch(Boolean(automaticLaunchId));
    try {
      const created = await createDesktopAuthorization(automaticLaunchId);
      if (!mounted.current || revision.current !== startingRevision) {
        void cancelDesktopAuthorization(created.id, created.secret).catch(() => undefined);
        return;
      }
      current.current = created;
      setRequest(created);
      setOutcome("pending");
      const nativeWindow = createDesktopApprovalWindow(window, () => mounted.current && revision.current === startingRevision);
      approvalWindow.current = nativeWindow;
      if (automaticLaunchId) void nativeWindow.minimize();
    } catch {
      if (mounted.current && revision.current === startingRevision) setError(true);
    } finally {
      if (mounted.current && revision.current === startingRevision) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!launchId || automaticStarted.current) return;
    automaticStarted.current = true;
    void start(launchId);
  }, [launchId, start]);

  const cancel = () => {
    revision.current += 1;
    const pending = current.current;
    current.current = null;
    setRequest(null);
    setOutcome("pending");
    if (pending) void cancelDesktopAuthorization(pending.id, pending.secret).catch(() => undefined);
  };

  const address = request ? `${window.location.origin}/desktop/verify/${encodeURIComponent(request.id)}` : "";
  return (
    <section className="link-panel desktop-browser-sign-in">
      <strong>{t("desktopSignIn.title")}</strong>
      {request && outcome === "pending" ? (
        <>
          <p className="desktop-launch-origin">{window.location.origin}</p>
          <p className="muted small">{t(usingLaunch ? "desktopSignIn.returnBrowser" : "desktopSignIn.compare")}</p>
          <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>{request.confirmation}</span>
          {!usingLaunch ? <>
            <a className="btn btn-primary" href={address} target="_blank" rel="noopener noreferrer" onClick={() => void approvalWindow.current?.minimize()}>{t("desktopSignIn.openBrowser")}</a>
          </> : null}
          <p className="muted small" role="status">{t("desktopSignIn.waiting")}</p>
          <button className="btn btn-ghost" type="button" onClick={cancel}>{t("common.cancel")}</button>
        </>
      ) : (
        <>
          <p className="muted small">{outcome === "refused" ? t("desktopSignIn.refused")
            : outcome === "expired" ? t("desktopSignIn.expired") : t("desktopSignIn.copy")}</p>
          {error ? <p className="device-error small" role="alert">{t("desktopSignIn.failed")}</p> : null}
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void start()}>{t("desktopSignIn.start")}</button>
        </>
      )}
    </section>
  );
}

/** Public request id in the address; approval still needs this browser's live session. */
export function DesktopBrowserApproval({ id, user, authState, language, t, onLanguageChange }: {
  id: string;
  user: PublicUser | null;
  authState: "loading" | "ready" | "error";
  language: LanguageCode;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
}) {
  const [request, setRequest] = useState<{ confirmation: string; label: string; origin: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState<"approved" | "refused" | null>(null);

  useEffect(() => {
    if (authState === "loading") return;
    if (!user || !id) { setLoading(false); return; }
    setLoading(true);
    let live = true;
    void fetchDesktopAuthorization(id)
      .then((value) => { if (live) setRequest(value); })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [authState, id, user?.id]);

  const answer = async (approve: boolean) => {
    setAnswering(true);
    setError(false);
    try {
      await answerDesktopAuthorization(id, approve);
      setAnswered(approve ? "approved" : "refused");
    } catch {
      setError(true);
    } finally {
      setAnswering(false);
    }
  };

  return (
    <AuthEntryFrame language={language} t={t} onLanguageChange={onLanguageChange}>

      <section className="link-panel">
        <strong>{t("desktopSignIn.approvalTitle")}</strong>
        {loading ? <p className="muted small">{t("common.checking")}</p>
          : !user ? <p className="muted small">{t("desktopSignIn.signInFirst")}</p>
            : answered ? <p role="status">{t(answered === "approved" ? "desktopSignIn.approved" : "desktopSignIn.refused")}</p>
              : request ? (
                <>
                  <p>{t("desktopSignIn.approvalCopy", { account: user.nickname, device: request.label })}</p>
                  <p className="muted small desktop-browser-address">{request.origin}</p>
                  <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>{request.confirmation}</span>
                  <p className="muted small">{t("link.confirmationHint")}</p>
                  <div className="confirm-actions">
                    <button className="btn btn-ghost" type="button" disabled={answering} onClick={() => void answer(false)}>{t("link.refuse")}</button>
                    <button className="btn btn-primary" type="button" disabled={answering} onClick={() => void answer(true)}>{t("link.approve")}</button>
                  </div>
                </>
              ) : <p className="muted small">{t("desktopSignIn.expired")}</p>}
        {error ? <p className="device-error small" role="alert">{t("desktopSignIn.failed")}</p> : null}
      </section>
    </AuthEntryFrame>
  );
}
