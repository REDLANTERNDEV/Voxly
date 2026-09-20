import { useCallback,useEffect,useState,type FormEvent } from "react";
import {
  decideAccountDeletionRequest,
  deleteOwnerAccount,
  fetchOwnerAccount,
  fetchOwnerAccounts,
  fetchOwnerDeletionRequests
} from "../../api.js";
import { formatShortDate } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import type { LanguageCode } from "../../lib/i18n.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import type { OwnerAccount,OwnerAccountMembership,OwnerDeletionRequest } from "../../types.js";

function Memberships({ memberships, t }: { memberships: OwnerAccountMembership[]; t: Translate }) {
  return (
    <ul className="dash-notes account-memberships">
      {memberships.map((membership) => (
        <li key={membership.serverId}>
          <strong>{membership.serverName}</strong>
          <span>{membership.nickname} · {t(membership.role === "owner" ? "common.owner" : "common.member")} · {t(`accountLifecycle.membership.${membership.state}`)}</span>
        </li>
      ))}
    </ul>
  );
}

export function OwnerDeletionRequestsSection({ language,timeFormat,revision,t,onCountChange }: {
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  revision: number;
  t: Translate;
  onCountChange(count: number): void;
}) {
  const [requests, setRequests] = useState<OwnerDeletionRequest[]>([]);
  const [decision, setDecision] = useState<{ request: OwnerDeletionRequest; kind: "approve" | "reject" } | null>(null);
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetchOwnerDeletionRequests();
      setRequests(response.requests);
      onCountChange(response.requests.length);
    } catch {
      setStatus(t("ownerAccounts.loadFailed"));
    }
  }, [onCountChange,t]);

  useEffect(() => { void load(); }, [load,revision]);

  return (
    <section className="dash-panel">
      <header className="dash-panel-head">
        <h2>{t("ownerAccounts.deletionRequests")}</h2>
        <p className="muted small">{t("ownerAccounts.deletionRequestsCopy")}</p>
      </header>
      {requests.length === 0 ? <p className="muted">{t("ownerAccounts.noDeletionRequests")}</p> : requests.map((request) => (
        <article className="owner-account-card" key={request.id}>
          <div>
            <strong>{request.nickname}</strong>
            <span className="muted small">{t(request.status === "banned" ? "common.banned" : "common.active")} · {formatShortDate(request.requestedAt, language, t, timeFormat)}</span>
          </div>
          <Memberships memberships={request.memberships} t={t} />
          <div className="message-actions">
            <button className="btn btn-danger" type="button" onClick={() => setDecision({ request, kind: "approve" })}>{t("ownerAccounts.approveDeletion")}</button>
            <button className="btn btn-ghost" type="button" onClick={() => setDecision({ request, kind: "reject" })}>{t("ownerAccounts.rejectDeletion")}</button>
          </div>
        </article>
      ))}
      {status ? <p role="status">{status}</p> : null}
      {decision ? <ConfirmDialog
        title={t(decision.kind === "approve" ? "ownerAccounts.approveTitle" : "ownerAccounts.rejectTitle", { nickname: decision.request.nickname })}
        copy={t(decision.kind === "approve" ? "ownerAccounts.approveCopy" : "ownerAccounts.rejectCopy")}
        confirmLabel={t(decision.kind === "approve" ? "ownerAccounts.approveDeletion" : "ownerAccounts.rejectDeletion")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setDecision(null)}
        onConfirm={() => {
          const current = decision;
          setDecision(null);
          void decideAccountDeletionRequest(current.request.id, current.kind)
            .then(load)
            .catch(() => setStatus(t("ownerAccounts.actionFailed")));
        }}
      /> : null}
    </section>
  );
}

export function OwnerAccountsSection({ t }: { t: Translate }) {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<OwnerAccount[]>([]);
  const [selected, setSelected] = useState<(OwnerAccount & { memberships: OwnerAccountMembership[] }) | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<(OwnerAccount & { memberships: OwnerAccountMembership[] }) | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [status, setStatus] = useState("");

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setConfirmation("");
    setPermanent(false);
  }

  function openDeleteDialog(account: OwnerAccount & { memberships: OwnerAccountMembership[] }) {
    setConfirmation("");
    setPermanent(false);
    setDeleteTarget(account);
  }

  const search = useCallback(async (value: string) => {
    try {
      setAccounts((await fetchOwnerAccounts(value)).accounts);
    } catch {
      setStatus(t("ownerAccounts.loadFailed"));
    }
  }, [t]);

  useEffect(() => { void search(""); }, [search]);

  async function select(account: OwnerAccount) {
    try {
      setSelected((await fetchOwnerAccount(account.id)).account);
    } catch {
      setStatus(t("ownerAccounts.loadFailed"));
    }
  }

  async function submitDelete(event: FormEvent) {
    event.preventDefault();
    if (!deleteTarget || confirmation !== deleteTarget.nickname || !permanent) return;
    try {
      await deleteOwnerAccount(deleteTarget.id, confirmation);
      closeDeleteDialog();
      setSelected(null);
      setStatus(t("ownerAccounts.deleted"));
      await search(query);
    } catch {
      setStatus(t("ownerAccounts.actionFailed"));
    }
  }

  const canDelete = selected
    && selected.role !== "owner"
    && !selected.isBot
    && !selected.deletedAt
    && selected.memberships.every((membership) => membership.role !== "owner");

  return (
    <section className="dash-panel">
      <header className="dash-panel-head">
        <h2>{t("ownerAccounts.accounts")}</h2>
        <p className="muted small">{t("ownerAccounts.accountsCopy")}</p>
      </header>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
        <label className="form-field">
          <span>{t("ownerAccounts.search")}</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <button className="btn" type="submit">{t("ownerAccounts.searchAction")}</button>
      </form>
      <div className="owner-account-layout">
        <div className="owner-account-list">
          {accounts.map((account) => (
            <button className="owner-account-row" type="button" key={account.id} onClick={() => void select(account)}>
              <strong>{account.deletedAt ? t("common.deletedMember") : account.nickname}</strong>
              <span>{account.bannedAt ? t("common.banned") : account.deletedAt ? t("ownerAccounts.deletedState") : t("common.active")} · {t("ownerAccounts.serverCount", { count: account.serverCount })}</span>
            </button>
          ))}
        </div>
        {selected ? <article className="owner-account-card">
          <h3>{selected.deletedAt ? t("common.deletedMember") : selected.nickname}</h3>
          <Memberships memberships={selected.memberships} t={t} />
          {canDelete ? <button className="btn btn-danger" type="button" onClick={() => openDeleteDialog(selected)}>{t("ownerAccounts.deleteNow")}</button> : <p className="muted small">{t("ownerAccounts.protected")}</p>}
        </article> : null}
      </div>
      {status ? <p role="status">{status}</p> : null}
      {deleteTarget ? <div className="confirm-backdrop" role="presentation">
        <form className="confirm-dialog" role="dialog" aria-modal="true" aria-label={t("ownerAccounts.deleteTitle", { nickname: deleteTarget.nickname })} onSubmit={submitDelete}>
          <h2>{t("ownerAccounts.deleteTitle", { nickname: deleteTarget.nickname })}</h2>
          <p>{t("ownerAccounts.deleteCopy")}</p>
          <label className="form-field"><span>{t("accountDeletion.confirmNickname", { nickname: deleteTarget.nickname })}</span><input autoFocus className="input" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} /></label>
          <label className="check-row"><input type="checkbox" checked={permanent} onChange={(event) => setPermanent(event.currentTarget.checked)} /><span>{t("accountDeletion.permanentConfirm")}</span></label>
          <div className="confirm-actions">
            <button className="btn btn-ghost" type="button" onClick={closeDeleteDialog}>{t("common.cancel")}</button>
            <button className="btn btn-danger" type="submit" disabled={confirmation !== deleteTarget.nickname || !permanent}>{t("ownerAccounts.deleteNow")}</button>
          </div>
        </form>
      </div> : null}
    </section>
  );
}
