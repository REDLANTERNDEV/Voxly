import { useCallback, useEffect, useRef, useState } from "react";
import type { Translate } from "../../app/types.js";
import { ModalDialog } from "../../components/ui/Dialogs.js";
import { installationOrigins, parseInviteInput, type ParsedInviteInput } from "../../lib/invites.js";

/**
 * The rail's "+": paste an Invite to join another Server (ADR-0036).
 *
 * It only joins. Whatever is pasted goes through the same parser a clicked
 * chat link does. This Installation's Invite opens the invite card, so there is
 * one Join path rather than two. Another Installation's Invite is named for
 * what it is: its Accounts are not ours, so it is handed off and never joined
 * from here.
 */
export function JoinServerDialog({
  returnFocus,
  t,
  onCancel,
  onOpenInvite
}: {
  returnFocus: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onOpenInvite: (token: string) => void;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<ParsedInviteInput | null>(null);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const desktop = typeof window !== "undefined" && window.__VOXLY_DESKTOP_V1__?.version === 1;
  const close = useCallback(() => {
    onCancel();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onCancel, returnFocus]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const elsewhere = result?.kind === "elsewhere" ? result : null;
  const host = elsewhere ? new URL(elsewhere.origin).host : "";

  // The shared shell renders at the document root: drawn in place, this
  // dialog sat inside the rail's stacking context, under the channel sidebar.
  return (
    <ModalDialog
      as="form"
      className="join-server-dialog"
      labelledBy="joinServerTitle"
      onDismiss={close}
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseInviteInput(value, installationOrigins());
        setResult(parsed);
        setCopied(false);
        if (parsed.kind === "here") {
          onCancel();
          onOpenInvite(parsed.token);
        }
      }}
    >
      <h2 id="joinServerTitle">{t("server.joinTitle")}</h2>
      <p className="muted small">{t("server.joinCopy")}</p>
      <label className="form-field" htmlFor="joinServerInvite">
        <span>{t("invite.codeLabel")}</span>
        <input
          ref={input}
          className="input"
          id="joinServerInvite"
          aria-invalid={result?.kind === "invalid"}
          aria-describedby="joinServerResult"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setResult(null);
          }}
        />
      </label>
      <div id="joinServerResult" aria-live="polite">
        {result?.kind === "invalid" ? <p className="error-text">{t("server.joinInvalid")}</p> : null}
        {elsewhere ? (
          <div className="join-server-elsewhere">
            <p className="small">{t("server.joinElsewhere", { host })}</p>
            {desktop ? (
              <>
                <p className="muted small">{t("server.joinElsewhereDesktop", { host })}</p>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(elsewhere.origin)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false));
                  }}
                >
                  {copied ? t("server.joinCopied") : t("server.joinCopyAddress")}
                </button>
              </>
            ) : (
              <a className="btn btn-ghost" href={elsewhere.url} target="_blank" rel="noopener noreferrer">
                {t("server.joinElsewhereOpen")}
              </a>
            )}
          </div>
        ) : null}
      </div>
      <div className="confirm-actions">
        <button className="btn btn-ghost" type="button" onClick={close}>
          {t("common.cancel")}
        </button>
        <button className="btn btn-primary" type="submit" disabled={!value.trim()}>
          {t("server.joinContinue")}
        </button>
      </div>
    </ModalDialog>
  );
}
