import { useState } from "react";
import type { Translate } from "../../app/types.js";
import { copyText } from "../../lib/copyText.js";
import { recoverAddress } from "../../lib/linkGuide.js";

/**
 * The Recovery code, on the one occasion it is ever readable.
 *
 * It is shown exactly once, and nothing can read it back — so this component's
 * only real job is to not let a member walk past it. The confirm checkbox is
 * that: it is not ceremony, it is the difference between a member who has a way
 * back and one who finds out they do not on the day their laptop dies.
 *
 * It also says **where the code is used**. A secret whose purpose nobody can
 * remember is a secret nobody keeps, and the address is the one thing a member
 * cannot look up later — by the time they need it they have no signed-in
 * Device to look it up from.
 *
 * Deliberately dressed differently from the Link code (`LinkDeviceDialog`).
 * One is worth ninety seconds and the other is worth the account until it is
 * replaced, and if the two look alike the second gets treated like the first.
 */
export function RecoveryCodeReveal({ code, t, onContinue }: {
  code: string;
  t: Translate;
  onContinue: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<"" | "done" | "failed">("");

  return (
    <section className="recovery-reveal">
      <strong>{t("recovery.revealTitle")}</strong>
      <p className="muted small">{t("recovery.revealCopy")}</p>
      <code className="recovery-code code-face">{code}</code>
      {/* `navigator.clipboard` is missing entirely outside a secure context, so
          over a plain-HTTP local address this button used to do nothing at all
          and say nothing about it. `copyText` falls back, and either way the
          member is told what happened. */}
      <button className="btn btn-ghost" type="button" onClick={() => { void copyText(code).then((ok) => setCopied(ok ? "done" : "failed")); }}>
        {copied === "done" ? t("recovery.copied") : t("recovery.copy")}
      </button>
      {copied === "failed" ? <p className="small muted">{t("common.copyFailed")}</p> : null}
      {/* Where it is used. By the time they need this they will have no
          signed-in Device to look the address up from. */}
      <p className="muted small">
        {t("recovery.whereToUse")}
        <code className="link-address">{recoverAddress()}</code>
      </p>
      <label className="recovery-confirm">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.currentTarget.checked)} />
        <span>{t("recovery.savedConfirm")}</span>
      </label>
      <button className="btn btn-primary" type="button" disabled={!saved} onClick={onContinue}>
        {t("common.done")}
      </button>
    </section>
  );
}
