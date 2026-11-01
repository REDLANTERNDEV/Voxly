import type { PresenceUser, PublicUser } from "@voxly/shared";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { fetchServers } from "../../api.js";
import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import type { MemberPresenceState } from "../../lib/memberDirectory.js";
import {
  changedNicknameRows,
  effectiveNickname,
  nicknameDraftError,
  nicknameMaxLength,
  nicknameRequestValue,
  type ProfileNicknameRow
} from "../../lib/profileNicknames.js";
import { CloseIcon } from "../ui/Icons.js";
import { PresenceDot } from "./AccountStatusMenu.js";

type Row = ProfileNicknameRow & {
  name: string;
  role: "owner" | "member";
  mentionCode: string | null;
  failed: boolean;
};

/**
 * How you read to the people you share a Server with: a preview card on the
 * left, and your nickname on every Server you belong to on the right.
 *
 * A native modal `<dialog>`, portalled to the body and rendered beside
 * Settings rather than inside it. The top layer keeps it above Settings and
 * traps focus; staying out of Settings' React tree keeps its backdrop's
 * mousedown from closing Settings through portal event bubbling. Escape is
 * always `preventDefault`ed here, which is what tells Settings' own Escape
 * listener that this keypress was already answered.
 *
 * Unsaved edits hold the dialog open. Every way out goes through
 * `requestClose`, which refuses while anything is unsaved and makes the
 * Save/Reset bar say so instead.
 */
export function ProfileDialog({
  user,
  activeServerId,
  selfState,
  t,
  onSave,
  onClose
}: {
  user: PublicUser;
  activeServerId: string;
  selfState: MemberPresenceState;
  t: Translate;
  onSave: (serverId: string, nickname: string | null) => Promise<PresenceUser>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  // Read once: the list must not reload under a member's unsaved edits when
  // the viewed server changes (a kick, a deletion) while the dialog is open.
  const initialServerId = useRef(activeServerId);
  const titleId = useId();
  const serversTitleId = useId();
  const fieldId = useId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [retryCount, setRetryCount] = useState(0);
  const [previewId, setPreviewId] = useState("");
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const changed = changedNicknameRows(rows);
  const dirty = changed.length > 0;
  const invalid = changed.some((row) => nicknameDraftError(row.draft));
  const preview = rows.find((row) => row.serverId === previewId) ?? rows[0];
  const previewName = preview ? effectiveNickname(preview.draft, user.nickname) : user.nickname;

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const element = dialogRef.current;
    element?.showModal();
    return () => {
      element?.close();
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  useEffect(() => {
    let current = true;
    fetchServers()
      .then((response) => {
        if (!current) return;
        setRows(
          response.servers.map((server) => ({
            serverId: server.id,
            name: server.name,
            role: server.role,
            mentionCode: server.mentionCode ?? null,
            saved: server.nickname ?? null,
            draft: server.nickname ?? "",
            failed: false
          }))
        );
        setPreviewId(
          (previous) =>
            previous ||
            (response.servers.some((server) => server.id === initialServerId.current) ? initialServerId.current : "")
        );
        setLoadState("ready");
      })
      .catch(() => {
        if (current) setLoadState("error");
      });
    return () => {
      current = false;
    };
  }, [retryCount]);

  const alertUnsaved = () => {
    setBlocked(true);
    const bar = barRef.current;
    if (!bar?.animate) return;
    const style = getComputedStyle(bar);
    // The theme's own tokens, read from the bar, so the blink matches both themes.
    const rest = { backgroundColor: style.backgroundColor, color: style.color };
    const alarm = {
      backgroundColor: style.getPropertyValue("--danger").trim(),
      color: style.getPropertyValue("--danger-on").trim()
    };
    // A refused close blinks the bar red; the shake is motion and goes with a
    // reduced-motion preference, the colour stays.
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bar.animate(
      reducedMotion
        ? [rest, alarm, rest, alarm, rest]
        : [
            { ...rest, transform: "translateX(0)" },
            { ...alarm, transform: "translateX(-8px)" },
            { ...alarm, transform: "translateX(8px)" },
            { ...alarm, transform: "translateX(-6px)" },
            { ...alarm, transform: "translateX(4px)" },
            { ...rest, transform: "translateX(0)" }
          ],
      { duration: reducedMotion ? 900 : 560, easing: "ease-out" }
    );
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      alertUnsaved();
      return;
    }
    onClose();
  };

  const updateDraft = (serverId: string, draft: string) =>
    setRows((current) => current.map((row) => (row.serverId === serverId ? { ...row, draft, failed: false } : row)));

  const reset = () => {
    setBlocked(false);
    setRows((current) => current.map((row) => ({ ...row, draft: row.saved ?? "", failed: false })));
  };

  const save = async () => {
    const pending = changedNicknameRows(rows);
    if (!pending.length || pending.some((row) => nicknameDraftError(row.draft))) return;
    setSaving(true);
    const results = await Promise.allSettled(
      pending.map((row) => onSave(row.serverId, nicknameRequestValue(row.draft)))
    );
    setRows((current) =>
      current.map((row) => {
        const index = pending.findIndex((entry) => entry.serverId === row.serverId);
        if (index < 0) return row;
        if (results[index].status === "rejected") return { ...row, failed: true };
        const value = nicknameRequestValue(pending[index].draft);
        return { ...row, saved: value, draft: value ?? "", failed: false };
      })
    );
    if (results.every((result) => result.status === "fulfilled")) setBlocked(false);
    setSaving(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    requestClose();
  };

  // Only a press that starts and ends on the backdrop closes; a text selection
  // dragged out of a field must not.
  const onMouseDown = (event: MouseEvent<HTMLDialogElement>) => {
    pressedBackdrop.current = event.target === dialogRef.current;
  };
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (pressedBackdrop.current && event.target === dialogRef.current) requestClose();
    pressedBackdrop.current = false;
  };

  const unsavedMessage = blocked ? t("profile.unsavedBlocked") : t("profile.unsaved");

  return createPortal(
    <dialog
      ref={dialogRef}
      className="profile-dialog"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      <div className="profile-dialog-frame">
        <header className="profile-dialog-head">
          <h2 id={titleId}>{t("profile.title")}</h2>
          <button
            className="icon-btn profile-dialog-close"
            type="button"
            autoFocus
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={requestClose}
          >
            <CloseIcon />
          </button>
        </header>
        <div className="profile-dialog-body">
          <aside className="profile-preview" aria-label={t("profile.previewLabel")}>
            <div className="profile-preview-banner" aria-hidden="true" />
            <div className="profile-preview-identity">
              <span
                className={`avatar profile-preview-avatar ${preview?.role === "owner" ? "owner" : ""}`}
                aria-hidden="true"
              >
                {initial(previewName)}
                <PresenceDot state={selfState} />
              </span>
              <strong className="profile-preview-name">{previewName}</strong>
              <span className="profile-preview-meta">
                {preview?.mentionCode ? <span className="mono">#{preview.mentionCode}</span> : null}
                {preview?.role === "owner" ? <span className="account-card-badge">{t("common.owner")}</span> : null}
              </span>
              <span className="profile-preview-status">
                <PresenceDot state={selfState} />
                {t(`presence.${selfState}` as const)}
              </span>
            </div>
            <dl className="profile-preview-facts">
              {preview ? (
                <div>
                  <dt>{t("profile.previewing")}</dt>
                  <dd>{preview.name}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t("profile.accountNickname")}</dt>
                <dd>{user.nickname}</dd>
                <dd className="muted small">{t("profile.accountNicknameHint")}</dd>
              </div>
            </dl>
          </aside>
          <section className="profile-servers" aria-labelledby={serversTitleId}>
            <div className="profile-servers-head">
              <h3 id={serversTitleId}>{t("profile.serverNicknames")}</h3>
              <p className="muted small">{t("profile.serverNicknamesHint", { nickname: user.nickname })}</p>
            </div>
            {loadState === "loading" ? (
              <p className="muted small profile-servers-state">{t("common.loading")}</p>
            ) : null}
            {loadState === "error" ? (
              <div className="profile-servers-state">
                <p className="error-text" role="alert">
                  {t("profile.loadFailed")}
                </p>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => {
                    setLoadState("loading");
                    setRetryCount((value) => value + 1);
                  }}
                >
                  {t("profile.retry")}
                </button>
              </div>
            ) : null}
            {loadState === "ready" && !rows.length ? (
              <p className="muted small profile-servers-state">{t("profile.noServers")}</p>
            ) : null}
            {loadState === "ready" && rows.length ? (
              <ul className="profile-server-list">
                {rows.map((row) => {
                  const inputId = `${fieldId}-${row.serverId}`;
                  const errorId = `${inputId}-error`;
                  const lengthError = nicknameDraftError(row.draft);
                  const error = lengthError
                    ? t("member.nicknameLength")
                    : row.failed
                      ? t("member.nicknameUpdateFailed")
                      : "";
                  const isChanged = nicknameRequestValue(row.draft) !== row.saved;
                  return (
                    <li
                      key={row.serverId}
                      className={`profile-server-row ${isChanged ? "is-changed" : ""} ${
                        row.serverId === preview?.serverId ? "is-previewed" : ""
                      }`}
                    >
                      <span className="profile-server-avatar" aria-hidden="true">
                        {initial(row.name)}
                      </span>
                      <span className="profile-server-copy">
                        <label className="profile-server-name" htmlFor={inputId}>
                          {row.name}
                        </label>
                        {row.role === "owner" ? <span className="account-card-badge">{t("common.owner")}</span> : null}
                      </span>
                      <span className="profile-server-field">
                        <input
                          className="input"
                          id={inputId}
                          value={row.draft}
                          placeholder={user.nickname}
                          maxLength={nicknameMaxLength}
                          autoComplete="off"
                          spellCheck={false}
                          readOnly={saving}
                          aria-label={t("profile.nicknameFor", { server: row.name })}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? errorId : undefined}
                          onFocus={() => setPreviewId(row.serverId)}
                          onChange={(event) => updateDraft(row.serverId, event.currentTarget.value)}
                        />
                        {row.draft ? (
                          <button
                            className="profile-server-clear"
                            type="button"
                            disabled={saving}
                            title={t("profile.clearNickname", { server: row.name })}
                            aria-label={t("profile.clearNickname", { server: row.name })}
                            onClick={() => {
                              updateDraft(row.serverId, "");
                              setPreviewId(row.serverId);
                              document.getElementById(inputId)?.focus();
                            }}
                          >
                            <CloseIcon />
                          </button>
                        ) : null}
                      </span>
                      {error ? (
                        <p className="error-text profile-server-error" id={errorId}>
                          {error}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        </div>
        <p className="sr-only" role="status">
          {dirty ? unsavedMessage : ""}
        </p>
        <div ref={barRef} className={`profile-unsaved ${blocked ? "is-blocked" : ""}`} hidden={!dirty}>
          <p>{unsavedMessage}</p>
          <div className="profile-unsaved-actions">
            <button className="btn btn-ghost" type="button" disabled={saving} onClick={reset}>
              {t("profile.reset")}
            </button>
            <button className="btn btn-primary" type="button" disabled={saving || invalid} onClick={() => void save()}>
              {saving ? t("profile.saving") : t("profile.save")}
            </button>
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  );
}
