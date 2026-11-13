import type { PresenceUser } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../app/types.js";

/**
 * Renders a modal at the document root. A dialog opened from the phone's
 * channel drawer would otherwise sit inside the drawer's stacking context,
 * under the scrim and the dock, and every tap meant for its field would land
 * on whatever is drawn above it. Without a document (static rendering) it
 * renders in place.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.fullscreenElement ?? document.body);
}

export function ConfirmDialog({
  title,
  copy,
  confirmLabel,
  cancelLabel,
  confirmationText,
  confirmationLabel,
  tone = "danger",
  onCancel,
  onConfirm
}: {
  title: string;
  copy: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmationText?: string;
  confirmationLabel?: string;
  /** A decision that destroys nothing confirms with the primary button, not a red one. */
  tone?: "danger" | "neutral";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmationRef = useRef<HTMLInputElement | null>(null);
  const [confirmationValue, setConfirmationValue] = useState("");
  const isConfirmationValid = !confirmationText || confirmationValue === confirmationText;
  // Callers pass a fresh `onCancel` on every render, and a realtime update
  // re-renders them often; reading it through a ref keeps the effects below
  // from re-running, which used to move focus back to Cancel mid-typing and
  // close a phone's keyboard.
  const cancelHandler = useRef(onCancel);
  cancelHandler.current = onCancel;

  // Focus once per opening: the field to type into when there is one, since
  // nothing can be confirmed without it, and otherwise the safe choice.
  useEffect(() => {
    (confirmationRef.current ?? cancelRef.current)?.focus();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelHandler.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <ModalPortal>
      <div
        className="confirm-backdrop"
        role="presentation"
        onMouseDown={onCancel}
        // A portal still bubbles through the React tree; a long press here is
        // not a press on the rail behind it.
        onContextMenu={(event) => event.stopPropagation()}
      >
        <section
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirmDialogTitle"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <h2 id="confirmDialogTitle">{title}</h2>
          <p>{copy}</p>
          {confirmationText ? (
            <label className="form-field" htmlFor="confirmDialogValue">
              <span className="label">{confirmationLabel}</span>
              <input
                ref={confirmationRef}
                className="input"
                id="confirmDialogValue"
                value={confirmationValue}
                onChange={(event) => setConfirmationValue(event.currentTarget.value)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && isConfirmationValid) {
                    event.preventDefault();
                    onConfirm();
                  }
                }}
              />
            </label>
          ) : null}
          <div className="confirm-actions">
            <button className="btn btn-ghost" type="button" ref={cancelRef} onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              className={`btn ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
              type="button"
              disabled={!isConfirmationValid}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </section>
      </div>
    </ModalPortal>
  );
}

export function NicknameDialog({
  user,
  returnFocus,
  t,
  onCancel,
  onSave
}: {
  user: PresenceUser;
  returnFocus?: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onSave: (nickname: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState(user.nickname);
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const close = useCallback(() => {
    onCancel();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onCancel, returnFocus]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSaving) close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isSaving]);

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!isSaving) close();
      }}
    >
      <form
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nicknameDialogTitle"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          const nextNickname = nickname.trim();
          if (nextNickname.length < 2 || nextNickname.length > 32) {
            setError(t("member.nicknameLength"));
            return;
          }
          setIsSaving(true);
          setError("");
          void onSave(nextNickname)
            .then(() => window.setTimeout(() => returnFocus?.focus(), 0))
            .catch(() => setError(t("member.nicknameUpdateFailed")))
            .finally(() => setIsSaving(false));
        }}
      >
        <h2 id="nicknameDialogTitle">{t("member.changeNickname")}</h2>
        <label className="form-field" htmlFor="nicknameDialogValue">
          <span>{t("member.nicknameLabel")}</span>
          <input
            className="input"
            id="nicknameDialogValue"
            ref={inputRef}
            value={nickname}
            minLength={2}
            maxLength={32}
            autoComplete="nickname"
            onChange={(event) => setNickname(event.currentTarget.value)}
          />
        </label>
        <p className={error ? "error-text" : "muted small"} aria-live="polite">
          {error || t("member.nicknameLength")}
        </p>
        <div className="confirm-actions">
          <button className="btn btn-ghost" type="button" disabled={isSaving} onClick={close}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" type="submit" disabled={isSaving}>
            {t("member.changeNickname")}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ChannelNameDialog({
  name: initialName,
  returnFocus,
  t,
  onCancel,
  onSave
}: {
  name: string;
  returnFocus: HTMLButtonElement | null;
  t: Translate;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const close = useCallback(() => {
    onCancel();
    window.setTimeout(() => returnFocus?.focus(), 0);
  }, [onCancel, returnFocus]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const controls = form.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)");
      if (!controls?.length) {
        event.preventDefault();
        return;
      }
      const first = controls[0],
        last = controls[controls.length - 1];
      if (!form.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [close, saving]);
  return (
    <ModalPortal>
      <div
        className="confirm-backdrop"
        onMouseDown={() => {
          if (!saving) close();
        }}
      >
        <form
          ref={form}
          noValidate
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="channelRenameTitle"
          aria-busy={saving}
          onMouseDown={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            const next = name.trim();
            if (next.length < 2 || next.length > 64) {
              setError(t("channel.nameLength"));
              return;
            }
            setSaving(true);
            setError("");
            void onSave(next)
              .then(close)
              .catch(() => setError(t("channel.renameFailed")))
              .finally(() => setSaving(false));
          }}
        >
          <h2 id="channelRenameTitle">{t("channel.rename")}</h2>
          <label className="form-field" htmlFor="channelRenameName">
            <span>{t("channel.name")}</span>
            <input
              ref={input}
              className="input"
              id="channelRenameName"
              aria-invalid={Boolean(error)}
              aria-describedby="channelRenameError"
              value={name}
              minLength={2}
              maxLength={64}
              autoComplete="off"
              disabled={saving}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <p id="channelRenameError" className="error-text" aria-live="polite">
            {error}
          </p>
          <div className="confirm-actions">
            <button className="btn btn-ghost" type="button" disabled={saving} onClick={close}>
              {t("common.cancel")}
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving || name.trim() === initialName}>
              {t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </ModalPortal>
  );
}
