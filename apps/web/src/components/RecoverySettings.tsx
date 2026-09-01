import { useCallback, useEffect, useState } from "react";
import { createRecoveryCode, fetchRecoveryStatus } from "../api.js";
import type { Translate } from "../app/types.js";
import { RecoveryCodeReveal } from "../features/auth/RecoveryCode.js";

/**
 * The Recovery code as a setting: whether you have one, and how to replace it.
 *
 * Its own card rather than a row inside Devices, and deliberately quieter than
 * the "Link a device" button beside it. A member who wants a second Device
 * should reach the cheap path; this one costs every other session when it is
 * used, and an interface that offers them as equals invites the expensive
 * choice for the cheap need (ADR-0014).
 *
 * Accounts created before this existed have no code, and are told so plainly.
 * That was the open question in ticket 03 and this is the answer: **offered,
 * prominently, never forced**. Forcing an interstitial on members who are
 * already signed in would interrupt people to solve a problem they do not have
 * yet, and a member who declines still has the Link code for every case except
 * losing everything at once.
 */
export function RecoverySettings({ t }: { t: Translate }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [revealed, setRevealed] = useState("");
  const [signedOutOthers, setSignedOutOthers] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPresent((await fetchRecoveryStatus()).present);
    } catch {
      setPresent(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const created = await createRecoveryCode();
      setRevealed(created.code);
      setSignedOutOthers(created.signedOutOthers);
      setPresent(true);
      setConfirming(false);
    } catch {
      setError(t("recovery.createFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  if (revealed) {
    return (
      <section className="theme-card recovery-card">
        {/* Said after the fact because it is a consequence, not a choice — the
            choice was confirmed before the code was made. */}
        {signedOutOthers ? <p className="small recovery-warning">{t("recovery.othersSignedOut")}</p> : null}
        <RecoveryCodeReveal code={revealed} t={t} onContinue={() => setRevealed("")} />
      </section>
    );
  }

  return (
    <section className="theme-card recovery-card">
      <div className="theme-card-head"><span className="label">{t("recovery.settingsTitle")}</span></div>
      <p className="muted small">{t("recovery.settingsHint")}</p>
      {error ? <p className="small device-error" role="alert">{error}</p> : null}
      {present === false ? <p className="small recovery-warning">{t("recovery.missing")}</p> : null}
      {present === true ? <p className="muted small">{t("recovery.present")}</p> : null}
      {/* Replacing signs every other Device out, so it asks first. Creating a
          first code is preventive and costs nothing, so it does not. */}
      {confirming ? (
        <>
          <p className="small recovery-warning">{t("recovery.regenerateWarning")}</p>
          <div className="confirm-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-danger" type="button" disabled={busy} onClick={() => void create()}>
              {t("recovery.regenerateConfirm")}
            </button>
          </div>
        </>
      ) : (
        <>
          <button
            className="btn btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => (present ? setConfirming(true) : void create())}
          >
            {present ? t("recovery.regenerate") : t("recovery.create")}
          </button>
          {present ? <p className="muted small">{t("recovery.regenerateHint")}</p> : null}
        </>
      )}
    </section>
  );
}
