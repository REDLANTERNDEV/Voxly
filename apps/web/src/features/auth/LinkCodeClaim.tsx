import { useEffect, useState } from "react";
import { claimDeviceLink, collectDeviceLink, type DeviceLinkOutcome } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { TurnstileWidget } from "./TurnstileWidget.js";
import { formatLinkCodeInput, isCompleteLinkCode } from "../../lib/linkCodeInput.js";
import { scannedLinkCode } from "../../lib/linkGuide.js";

/**
 * The arriving Device's half of linking: type the code, then wait to be let in.
 *
 * The wait is the feature. This cannot sign anybody in on its own — it holds a
 * claim token and polls, and the answer stays `pending` until a person
 * approves on the Device that minted the code. Somebody who read the code off a
 * screen share reaches exactly this point and gets no further (ADR-0014).
 *
 * It is a part, not a screen, so the invite card can run it before accepting
 * an Invite as the Account the visitor already has (ADR-0036).
 */
export function LinkCodeClaim({
  t,
  onLinked,
  turnstileSiteKey,
  onLostDevice
}: {
  t: Translate;
  onLinked: () => void;
  /** The operator's challenge, when they configured one. */
  turnstileSiteKey: string | null;
  /** Offered in place of the `/recover` link when the caller keeps the member on its own surface. */
  onLostDevice?: () => void;
}) {
  const [code, setCode] = useState(() => formatLinkCodeInput(scannedLinkCode()));
  const [scanned] = useState(() => scannedLinkCode().length > 0);
  const [claimToken, setClaimToken] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [outcome, setOutcome] = useState<DeviceLinkOutcome>("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const claim = await claimDeviceLink(code, turnstileToken || undefined);
      setClaimToken(claim.claimToken);
      setConfirmation(claim.confirmation);
    } catch {
      // One answer for unknown, expired and already-used, matching the server.
      // Telling a guesser which half was wrong is the whole thing to avoid.
      setError("link.codeInvalid");
      if (turnstileSiteKey) {
        // A spent challenge cannot be presented twice, so a retry needs a fresh
        // one or the member's second attempt fails for a reason they cannot see.
        setTurnstileToken("");
        setTurnstileResetKey((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  // A scanned code arrives in the fragment. Take it, then take it out of the
  // address bar: a fragment never reaches the server, but it does sit in the
  // phone's history, and there is no reason for it to stay there.
  useEffect(() => {
    if (!scanned) return;
    window.history.replaceState(null, "", window.location.pathname);
  }, [scanned]);

  useEffect(() => {
    if (!claimToken || outcome !== "pending") return;
    const timer = window.setInterval(() => {
      void collectDeviceLink(claimToken)
        .then((response) => {
          setOutcome(response.status);
          if (response.status === "approved") onLinked();
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [claimToken, onLinked, outcome]);

  return claimToken ? (
    <section className="link-panel">
      <strong>{t("link.waitingTitle")}</strong>
      <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>
        {confirmation}
      </span>
      <p className="muted small">
        {outcome === "pending"
          ? t("link.waitingCopy")
          : outcome === "refused"
            ? t("link.refused")
            : outcome === "expired"
              ? t("link.expired")
              : t("link.linked")}
      </p>
      {outcome === "refused" || outcome === "expired" ? (
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => {
            setClaimToken("");
            setOutcome("pending");
            setCode("");
          }}
        >
          {t("link.startOver")}
        </button>
      ) : null}
    </section>
  ) : (
    <form className="link-panel" onSubmit={(event) => void submit(event)}>
      <strong>{t("link.enterTitle")}</strong>
      <p className="muted small">{t("link.enterCopy")}</p>
      <input
        className="input link-input code-face"
        name="linkCode"
        autoComplete="one-time-code"
        inputMode="text"
        maxLength={12}
        autoCapitalize="characters"
        spellCheck={false}
        aria-label={t("link.codeLabel")}
        placeholder="XXXX-XXX-XXX"
        value={code}
        onChange={(event) => setCode(formatLinkCodeInput(event.currentTarget.value))}
      />
      {turnstileSiteKey ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          resetKey={turnstileResetKey}
          onToken={setTurnstileToken}
          onUnavailable={() => setTurnstileToken("")}
        />
      ) : null}
      {error ? (
        <p className="small device-error" role="alert">
          {t("link.codeInvalid")}
        </p>
      ) : null}
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || !isCompleteLinkCode(code) || (Boolean(turnstileSiteKey) && !turnstileToken)}
      >
        {t("link.continue")}
      </button>
      {/* The case this screen cannot serve: no signed-in Device to read a
              code from. Offered plainly, because that is what Recovery is for. */}
      {onLostDevice ? (
        <button className="btn btn-ghost small recovery-link" type="button" onClick={onLostDevice}>
          {t("recovery.lostDevice")}
        </button>
      ) : (
        <a className="small muted recovery-link" href="/recover">
          {t("recovery.lostDevice")}
        </a>
      )}
    </form>
  );
}
