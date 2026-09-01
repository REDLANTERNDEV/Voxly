import { useCallback, useEffect, useRef, useState } from "react";
import {
  answerDeviceLink,
  cancelDeviceLink,
  createDeviceLink,
  fetchWaitingDeviceLink
} from "../../api.js";
import type { Translate } from "../../app/types.js";
import { RefreshIcon } from "../../components/ui/Icons.js";
import { copyText } from "../../lib/copyText.js";
import type { TranslationKey } from "../../lib/i18n.js";
import { linkAddress, linkScanUrl, readLinkGuideDismissed, writeLinkGuideDismissed } from "../../lib/linkGuide.js";
import { encodeQr, qrPath } from "../../lib/qr.js";

/**
 * The signed-in Device's half of linking: show a code, then approve what turns
 * up holding it.
 *
 * The approval prompt is the reason this is a dialog and not a line of text
 * with a code in it. A member has to see *what* is asking — the confirmation
 * number their other Device is displaying, and what kind of Device it is —
 * because approving whatever happens to arrive would give back exactly the
 * property the approval step exists to buy (ADR-0014).
 */
export function LinkDeviceDialog({ t, onClose }: { t: Translate; onClose: () => void }) {
  const [code, setCode] = useState("");
  const [expiresIn, setExpiresIn] = useState(0);
  const [waiting, setWaiting] = useState<{ confirmation: string; label: string } | null>(null);
  // A key rather than a sentence, so translating happens at render and `t` does
  // not have to be a dependency of the effect that mints the code. It used to
  // be, and a `t` that changed identity would mint a second code and retire the
  // one on screen.
  const [errorKey, setErrorKey] = useState<TranslationKey | "">("");
  const [answering, setAnswering] = useState(false);
  const [linked, setLinked] = useState(false);
  // Read inside the mint effect's cleanup, which must not re-run on it.
  const linkedRef = useRef(false);
  linkedRef.current = linked;
  // Shown the first time, and reopenable afterwards. A member holding a code
  // with no idea what to do with it is the whole failure this prevents — and
  // the instruction lives on the *other* Device, which is the one place this
  // interface cannot reach.
  const [guiding, setGuiding] = useState(() => !readLinkGuideDismissed());
  // Bumping this mints a new code in place. A code that has run out used to
  // need going back through the guide and forward again, which is a lot of
  // clicking to say "the same thing, again".
  const [generation, setGeneration] = useState(0);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");
  const secondsLeft = useCountdown(expiresIn);
  const error = errorKey ? t(errorKey) : "";
  // Only once a code is on screen — before that there is nothing to have run
  // out, and the dialog is still fetching.
  const expired = Boolean(code) && secondsLeft <= 0;
  const renew = () => {
    setCode("");
    setExpiresIn(0);
    setCopied("");
    setGeneration((value) => value + 1);
  };

  /**
   * Minted once, and retired by id when the dialog closes.
   *
   * Both halves matter. React's development double-mount runs setup, cleanup,
   * setup — so a cleanup that retired "whatever is outstanding" would kill the
   * code the second setup had just minted, and the member would be told a
   * perfectly good code had expired. Naming the id makes the cleanup harmless
   * whichever order the three requests land in.
   */
  useEffect(() => {
    // Nothing is minted while the guide is up. The code is worth ninety
    // seconds, and burning them behind an explanation the member is still
    // reading would hand them a code that is already half spent.
    if (guiding) return;
    let live = true;
    let minted = "";
    void createDeviceLink()
      .then((link) => {
        minted = link.linkId;
        if (!live) {
          void cancelDeviceLink(link.linkId).catch(() => undefined);
          return;
        }
        setCode(link.code);
        setExpiresIn(link.expiresInSeconds);
      })
      .catch(() => { if (live) setErrorKey("link.mintFailed"); });
    return () => {
      live = false;
      // A code nobody is watching should not stay alive. If the mint has not
      // resolved yet the branch above retires it instead.
      //
      // Not once it has been approved, though: at that point it is a session
      // the arriving Device has not picked up rather than a code on screen, and
      // the server refuses to retire it either. Skipping the request here just
      // saves a round trip that would do nothing.
      if (minted && !linkedRef.current) void cancelDeviceLink(minted).catch(() => undefined);
    };
  }, [guiding, generation]);

  useEffect(() => {
    if (!code || linked) return;
    const timer = window.setInterval(() => {
      void fetchWaitingDeviceLink()
        .then((response) => setWaiting(response.waiting))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [code, linked]);

  const answer = useCallback(async (approve: boolean) => {
    setAnswering(true);
    try {
      await answerDeviceLink(approve);
      setWaiting(null);
      if (approve) setLinked(true);
    } catch {
      setErrorKey("link.answerFailed");
    } finally {
      setAnswering(false);
    }
  }, [t]);

  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog link-dialog" role="dialog" aria-modal="true" aria-label={t("link.title")}>
        <strong>{t("link.title")}</strong>
        {guiding ? (
          <>
            <p className="muted small">{t("link.guideCopy")}</p>
            <ol className="link-steps">
              <li>{t("link.step1")}<code className="link-address">{linkAddress()}</code></li>
              <li>{t("link.step2")}</li>
              <li>{t("link.step3")}</li>
            </ol>
            <div className="confirm-actions">
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => { writeLinkGuideDismissed(true); setGuiding(false); }}
              >
                {t("link.dontShowAgain")}
              </button>
              <button className="btn btn-primary" type="button" onClick={() => setGuiding(false)}>
                {t("link.guideContinue")}
              </button>
            </div>
          </>
        ) : (
        <>
        {error ? <p className="small device-error" role="alert">{error}</p> : null}
        {linked ? (
          <>
            <p className="muted small">{t("link.linked")}</p>
            <button className="btn btn-primary" type="button" onClick={onClose}>{t("common.done")}</button>
          </>
        ) : waiting ? (
          <>
            {/* Named before the number, because "is this mine?" is the question
                being asked and the Device is what answers it. */}
            <p>{t("link.approveCopy", { device: waiting.label })}</p>
            <span className="link-confirmation code-face" aria-label={t("link.confirmationLabel")}>{waiting.confirmation}</span>
            <p className="muted small">{t("link.confirmationHint")}</p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" type="button" disabled={answering} onClick={() => void answer(false)}>
                {t("link.refuse")}
              </button>
              <button className="btn btn-primary" type="button" disabled={answering} onClick={() => void answer(true)}>
                {t("link.approve")}
              </button>
            </div>
          </>
        ) : (
          <>
            <ol className="link-steps">
              <li>{t("link.step1")}<code className="link-address">{linkAddress()}</code></li>
              <li>{t("link.step2")}</li>
              <li>{t("link.step3")}</li>
            </ol>
            <p className="muted small">{t("link.codeCopy")}</p>
            {/* Scanning and typing are both offered, always. A camera that will
                not focus, a cracked lens, or a member who simply prefers typing
                all have to keep working — so the QR is the faster path, never
                the only one. */}
            {/* Expired covers both the code and the QR, with the way out on top
                of them. A member typing a dead code and being told "invalid"
                has been left to work out why on their own. */}
            <div className={`link-code-block ${expired ? "is-expired" : ""}`}>
              {code ? <LinkQr code={code} label={t("link.scanHint")} /> : null}
              <span className="link-code code-face">{code || "…"}</span>
              {expired ? (
                <button className="btn btn-primary link-renew" type="button" onClick={renew}>
                  <RefreshIcon />
                  <span>{t("link.newCode")}</span>
                </button>
              ) : null}
            </div>
            {/* Nothing to copy once it is dead — offering it invites a member to
                carry a code that will be refused. It comes back with the code. */}
            {code && !expired ? (
              <button className="btn btn-ghost link-copy" type="button" onClick={() => { void copyText(code).then((ok) => setCopied(ok ? "done" : "failed")); }}>
                {copied === "done" ? t("recovery.copied") : t("recovery.copy")}
              </button>
            ) : null}
            {copied === "failed" ? <p className="small muted">{t("common.copyFailed")}</p> : null}
            {/* Centred, a size up, and only the number carries the colour —
                the sentence around it is not the alarming part. */}
            <p className="link-countdown">
              {expired ? t("link.expired") : (
                <>
                  {t("link.expiresPrefix")}
                  <strong className={secondsLeft <= 20 ? "is-urgent" : ""}>{secondsLeft}</strong>
                  {t("link.expiresSuffix")}
                </>
              )}
            </p>
            <div className="confirm-actions">
              {/* Always available, whether or not the guide was dismissed —
                  "don't show me again" is not "never let me see this again". */}
              {/* Reopening the guide retires the code and mints a fresh one on
                  the way back, so a member who stops to re-read never returns
                  to a countdown that ran out while they did. */}
              <button className="btn btn-ghost" type="button" onClick={() => { setCode(""); setExpiresIn(0); setGuiding(true); }}>
                {t("link.howItWorks")}
              </button>
              <button className="btn btn-ghost" type="button" onClick={onClose}>{t("common.cancel")}</button>
            </div>
          </>
        )}
        </>
        )}
      </section>
    </div>
  );
}

/**
 * The code as something a camera can read.
 *
 * Drawn as one SVG path rather than a rect per module: far fewer nodes, and no
 * seams between neighbouring modules when it scales. The quiet zone is part of
 * the drawing because a code flush against a dark dialog does not scan.
 */
function LinkQr({ code, label }: { code: string; label: string }) {
  const matrix = encodeQr(linkScanUrl(code));
  const quiet = 4;
  const span = matrix.length + quiet * 2;
  return (
    <figure className="link-qr">
      <svg viewBox={`0 0 ${span} ${span}`} role="img" aria-label={label}>
        <rect width={span} height={span} fill="#fff" />
        <g transform={`translate(${quiet} ${quiet})`}>
          <path d={qrPath(matrix)} fill="#000" />
        </g>
      </svg>
      <figcaption className="muted small">{label}</figcaption>
    </figure>
  );
}

/**
 * Seconds remaining, counted from a duration rather than to a timestamp.
 *
 * The server's absolute expiry stays authoritative — it is what actually
 * refuses the code — but subtracting it from the browser's clock makes the
 * *display* only as correct as the two clocks agreeing. A member whose device
 * is a few minutes out would be shown a code marked expired that works fine, or
 * one counting minutes that does not. Counting a known duration down locally
 * cannot be wrong in that way.
 *
 * Floored at zero: a code that has run out says so rather than counting into
 * negatives, and the member's next move is to ask for another.
 */
export function useCountdown(seconds: number) {
  const [remaining, setRemaining] = useState(seconds);
  const startedAt = useRef(0);

  useEffect(() => {
    if (seconds <= 0) {
      setRemaining(0);
      return;
    }
    startedAt.current = Date.now();
    setRemaining(seconds);
    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt.current) / 1000;
      setRemaining(Math.max(0, Math.ceil(seconds - elapsed)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [seconds]);

  return remaining;
}
