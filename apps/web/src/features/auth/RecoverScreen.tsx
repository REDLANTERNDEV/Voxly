import { useCallback, useState } from "react";
import { redeemRecoveryCode } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { TurnstileWidget } from "./InviteScreen.js";
import { BrandLockup } from "../../components/ui/Navigation.js";
import { formatRecoveryCodeInput, isCompleteRecoveryCode } from "../../lib/linkCodeInput.js";
import { readRecoverGuideDismissed, writeRecoverGuideDismissed } from "../../lib/linkGuide.js";

/**
 * Getting back in with no Device left.
 *
 * The cost is stated **before** the code is entered, not after. A member who
 * reached for this when they meant to link a Device is about to sign themselves
 * out of everything, and finding that out afterwards is not a warning — it is a
 * surprise. See ADR-0014.
 *
 * On success the member lands straight in the app. No replacement code is
 * pushed on them here: they have just recovered, which is the least careful
 * moment to hand somebody a new secret to look after, and the code they used is
 * spent either way. The settings card then says the account has none, so making
 * a new one is a decision rather than a step to click past.
 */
export function RecoverScreen({ t, onRecovered, turnstileSiteKey }: {
  t: Translate;
  onRecovered: () => void;
  /** The operator's challenge, when they configured one. */
  turnstileSiteKey: string | null;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  // A member arriving here is having a bad day — they have lost every Device.
  // Saying plainly what this is, and what it will cost, before they start is
  // worth more here than anywhere else in the product.
  const [guiding, setGuiding] = useState(() => !readRecoverGuideDismissed());

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await redeemRecoveryCode(code, turnstileToken || undefined);
      onRecovered();
    } catch {
      // One answer for unknown, spent and superseded, matching the server.
      setError(t("recovery.invalid"));
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileResetKey((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }, [code, t]);

  return (
    <main className="landing link-screen">
      <BrandLockup subtitle="" />
      {guiding ? (
        <section className="link-panel">
          <strong>{t("recovery.guideTitle")}</strong>
          <p className="muted small">{t("recovery.guideCopy")}</p>
          <ol className="link-steps">
            <li>{t("recovery.guideStep1")}</li>
            <li>{t("recovery.guideStep2")}</li>
            <li>{t("recovery.guideStep3")}</li>
          </ol>
          <p className="small recovery-warning">{t("recovery.noCode")}</p>
          <div className="confirm-actions">
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => { writeRecoverGuideDismissed(true); setGuiding(false); }}
            >
              {t("link.dontShowAgain")}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setGuiding(false)}>
              {t("recovery.guideContinue")}
            </button>
          </div>
        </section>
      ) : (
        <form className="link-panel" onSubmit={(event) => void submit(event)}>
          <strong>{t("recovery.title")}</strong>
          <p className="muted small">{t("recovery.enterCopy")}</p>
          {/* Stated before the field, so it cannot be read as a consequence
              somebody discovers after the fact. */}
          <p className="recovery-warning" role="note">{t("recovery.cost")}</p>
          {/* A textarea rather than an input: twenty-five characters and four
              dashes do not fit on one line at a size anybody can check, and an
              input that scrolls sideways hides the half being read. Enter still
              submits, because it is a single field and that is what a member
              expects. */}
          <textarea
            className="input recovery-input code-face"
            name="recoveryCode"
            rows={2}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-label={t("recovery.codeLabel")}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            maxLength={29}
            value={code}
            onChange={(event) => setCode(formatRecoveryCodeInput(event.currentTarget.value))}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (isCompleteRecoveryCode(code)) void submit(event);
            }}
          />
          {turnstileSiteKey ? (
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              resetKey={turnstileResetKey}
              onToken={setTurnstileToken}
              onUnavailable={() => setTurnstileToken("")}
            />
          ) : null}
          {error ? <p className="small device-error" role="alert">{error}</p> : null}
          <button className="btn btn-primary" type="submit" disabled={busy || !isCompleteRecoveryCode(code) || (Boolean(turnstileSiteKey) && !turnstileToken)}>
            {t("recovery.continue")}
          </button>
          {/* Always available, whether or not the guide was dismissed. */}
          <button className="btn btn-ghost" type="button" onClick={() => setGuiding(true)}>
            {t("recovery.howItWorks")}
          </button>
        </form>
      )}
    </main>
  );
}
