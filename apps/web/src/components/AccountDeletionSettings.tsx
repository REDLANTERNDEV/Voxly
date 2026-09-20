import { useEffect,useState,type FormEvent } from "react";
import {
  ApiError,
  cancelAccountDeletionRequest,
  fetchAccountDeletionRequest,
  requestAccountDeletion
} from "../api.js";
import type { Translate } from "../app/types.js";
import { remainingDeletionCooldownHours } from "../lib/accountDeletion.js";
import type { AccountDeletionRequest } from "../types.js";

export function AccountDeletionSettings({ nickname, t }: { nickname: string; t: Translate }) {
  const [request, setRequest] = useState<AccountDeletionRequest | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const cooldownHours = request ? remainingDeletionCooldownHours(request) : null;

  useEffect(() => {
    let active = true;
    void fetchAccountDeletionRequest()
      .then((response) => { if (active) setRequest(response.request); })
      .catch(() => { if (active) setStatus(t("accountDeletion.loadFailed")); });
    return () => { active = false; };
  }, [t]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmation !== nickname || !understood) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await requestAccountDeletion(confirmation);
      setRequest(response.request);
      setConfirmation("");
      setUnderstood(false);
      setStatus(t("accountDeletion.requested"));
    } catch (error) {
      setStatus(error instanceof ApiError && error.code === "deletion_request_cooldown"
        ? t("accountDeletion.cooldown")
        : t("accountDeletion.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setStatus("");
    try {
      await cancelAccountDeletionRequest();
      setRequest((current) => current ? { ...current, status: "cancelled", resolvedAt: new Date().toISOString() } : null);
      setStatus(t("accountDeletion.cancelled"));
    } catch {
      setStatus(t("accountDeletion.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (request?.status === "pending") {
    return (
      <section className="theme-card danger-card">
        <div className="theme-card-head"><span className="label">{t("accountDeletion.title")}</span></div>
        <h3>{t("accountDeletion.pendingTitle")}</h3>
        <p className="muted small">{t("accountDeletion.pendingCopy")}</p>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void cancel()}>{t("accountDeletion.cancelRequest")}</button>
        {status ? <p className="small" role="status">{status}</p> : null}
      </section>
    );
  }

  return (
    <section className="theme-card danger-card">
      <div className="theme-card-head"><span className="label">{t("accountDeletion.title")}</span></div>
      <h3>{t("accountDeletion.requestTitle")}</h3>
      <p className="muted small">{t("accountDeletion.requestCopy")}</p>
      {request?.status === "rejected" ? <p className="error-text">{t("accountDeletion.rejected")}</p> : null}
      {request?.status === "cancelled" ? <p className="muted small">{t("accountDeletion.cancelledState")}</p> : null}
      {cooldownHours ? <p className="muted small">{t("accountDeletion.cooldownRemaining", { hours: cooldownHours })}</p> : null}
      <form onSubmit={submit}>
        <label className="form-field">
          <span>{t("accountDeletion.confirmNickname", { nickname })}</span>
          <input className="input" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.currentTarget.checked)} />
          <span>{t("accountDeletion.permanentConfirm")}</span>
        </label>
        <button className="btn btn-danger" type="submit" disabled={busy || confirmation !== nickname || !understood}>{t("accountDeletion.sendRequest")}</button>
      </form>
      {status ? <p className="small" role="status">{status}</p> : null}
    </section>
  );
}
