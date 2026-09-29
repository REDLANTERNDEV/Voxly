import { useEffect, useRef, useState } from "react";
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
import { AuthPageHeader } from "../../components/ui/Primitives.js";
import type { LanguageCode } from "../../lib/i18n.js";

/** The private collection secret lives only in this desktop webview's memory. */
export function DesktopBrowserSignIn({ t, onLinked }: { t: Translate; onLinked: () => void }) {
  const [request, setRequest] = useState<DesktopAuthorization | null>(null);
  const current = useRef<DesktopAuthorization | null>(null);
  const mounted = useRef(false);
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
    let timeout = 0;
    let delay = 1500;
    const poll = async () => {
      try {
        const response = await collectDesktopAuthorization(request.id, request.secret);
        if (!live) return;
        if (response.status === "approved") {
          current.current = null;
          onLinked();
          return;
        }
        if (response.status !== "pending") {
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

  const start = async () => {
    setBusy(true);
    setError(false);
    try {
      const created = await createDesktopAuthorization();
      if (!mounted.current) {
        void cancelDesktopAuthorization(created.id, created.secret).catch(() => undefined);
        return;
      }
      current.current = created;
      setRequest(created);
      setOutcome("pending");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
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
          <p className="muted small">{t("desktopSignIn.compare")}</p>
          <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>{request.confirmation}</span>
          <a className="btn btn-primary" href={address} target="_blank" rel="noopener noreferrer">{t("desktopSignIn.openBrowser")}</a>
          <code className="desktop-browser-address">{address}</code>
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
    <main className="landing link-screen">
      <AuthPageHeader language={language} t={t} onLanguageChange={onLanguageChange} />
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
    </main>
  );
}
