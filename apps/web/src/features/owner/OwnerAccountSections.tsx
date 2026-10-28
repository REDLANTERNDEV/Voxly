import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  decideAccountDeletionRequest,
  deleteOwnerAccount,
  fetchOwnerAccount,
  fetchOwnerAccounts,
  fetchOwnerDeletionRequests
} from "../../api.js";
import { formatShortDate } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ArrowIcon, TrashIcon } from "../../components/ui/Icons.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import type { LanguageCode } from "../../lib/i18n.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import type {
  InviteTrailPerson,
  OwnerAccount,
  OwnerAccountMembership,
  OwnerDeletionRequest,
  OwnerInvitedGroup
} from "../../types.js";
import { InviterName } from "./OwnerInviteTable.js";

type AccountDetail = OwnerAccount & { memberships: OwnerAccountMembership[]; invited?: OwnerInvitedGroup[] };

type TrailContext = {
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  onOpen(userId: string): void;
};

/**
 * A name in the Invite trail that opens that Account's details, so an owner
 * can follow one connection to the next. A Deleted account opens nothing.
 */
function TrailPersonLink({
  person,
  t,
  onOpen
}: {
  person: InviteTrailPerson;
  t: Translate;
  onOpen(userId: string): void;
}) {
  if (person.state === "deleted" || person.nickname === null) return <InviterName person={person} t={t} />;
  return (
    <button
      className="trail-person-link"
      type="button"
      aria-label={t("ownerAccounts.openAccount", { nickname: person.nickname })}
      onClick={() => onOpen(person.userId)}
    >
      <InviterName person={person} t={t} />
    </button>
  );
}

function Memberships({
  memberships,
  t,
  trail
}: {
  memberships: OwnerAccountMembership[];
  t: Translate;
  trail?: TrailContext;
}) {
  return (
    <ul className="account-memberships">
      {memberships.map((membership) => (
        <li key={membership.serverId}>
          <strong>{membership.serverName}</strong>
          <span>
            {membership.nickname} · {t(membership.role === "owner" ? "common.owner" : "common.member")} ·{" "}
            {t(`accountLifecycle.membership.${membership.state}`)}
          </span>
          {trail ? (
            membership.invite ? (
              <span className="account-joined-with small">
                {t("ownerAccounts.joinedWith", {
                  date: formatShortDate(membership.invite.joinedAt, trail.language, t, trail.timeFormat),
                  invite: membership.invite.label || t("owner.unlabeledInvite")
                })}
                <span>
                  <span className="muted">{t("owner.createdBy")}</span>{" "}
                  <TrailPersonLink person={membership.invite.inviter} t={t} onOpen={trail.onOpen} />
                </span>
              </span>
            ) : (
              <span className="muted small">{t("ownerAccounts.noInviteOnRecord")}</span>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PeopleInvited({ groups, t, trail }: { groups: OwnerInvitedGroup[]; t: Translate; trail: TrailContext }) {
  if (groups.length === 0) return <p className="muted small">{t("ownerAccounts.noPeopleInvited")}</p>;
  return (
    <div className="account-invited">
      {groups.map((group) => (
        <section key={group.serverId} aria-label={group.serverName}>
          <h4>{group.serverName}</h4>
          <ul className="account-memberships">
            {group.people.map((person) => (
              <li key={`${person.inviteId}:${person.userId}`}>
                <span className="invite-trail-name">
                  <TrailPersonLink person={person} t={t} onOpen={trail.onOpen} />
                </span>
                <span className="muted small">
                  {t("ownerAccounts.invitedThrough", {
                    invite: person.inviteLabel || t("owner.unlabeledInvite"),
                    date: formatShortDate(person.joinedAt, trail.language, t, trail.timeFormat)
                  })}
                </span>
                <span className={`invite-trail-state is-${person.state}`}>
                  {t(`inviteTrail.state.${person.state}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function OwnerDeletionRequestsSection({
  language,
  timeFormat,
  revision,
  t,
  onCountChange
}: {
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  revision: number;
  t: Translate;
  onCountChange(count: number): void;
}) {
  const [requests, setRequests] = useState<OwnerDeletionRequest[] | null>(null);
  const [decision, setDecision] = useState<{ request: OwnerDeletionRequest; kind: "approve" | "reject" } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await fetchOwnerDeletionRequests();
      setRequests(response.requests);
      onCountChange(response.requests.length);
    } catch {
      setRequests((current) => current ?? []);
      setStatus(t("ownerAccounts.loadFailed"));
    }
  }, [onCountChange, t]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <section className="dash-panel owner-accounts-panel owner-deletion-panel">
      <header className="accounts-directory-head">
        <div>
          <h2>
            {t("ownerAccounts.pendingRequests")}
            {requests && requests.length > 0 ? <span className="badge">{requests.length}</span> : null}
          </h2>
          <p className="muted small">{t("ownerAccounts.deletionRequestsCopy")}</p>
        </div>
      </header>
      {requests === null ? (
        <p className="owner-account-empty muted" role="status">
          {t("common.loading")}
        </p>
      ) : requests.length === 0 ? (
        <p className="owner-account-empty muted">{t("ownerAccounts.noDeletionRequests")}</p>
      ) : (
        <ul className="owner-deletion-list">
          {requests.map((request) => (
            <li key={request.id}>
              <article className="owner-deletion-card" aria-labelledby={`deletionRequest-${request.id}`}>
                <header className="owner-deletion-head">
                  <span className="avatar" aria-hidden="true">
                    {Array.from(request.nickname)[0]?.toUpperCase()}
                  </span>
                  <span className="owner-deletion-identity">
                    <strong id={`deletionRequest-${request.id}`}>{request.nickname}</strong>
                    <span className="muted small">
                      {t("ownerAccounts.requestedOn", {
                        date: formatShortDate(request.requestedAt, language, t, timeFormat)
                      })}
                    </span>
                  </span>
                  <span className={`account-state ${request.status === "banned" ? "is-banned" : ""}`}>
                    {t(request.status === "banned" ? "common.banned" : "common.active")}
                  </span>
                </header>
                <Memberships memberships={request.memberships} t={t} />
                <footer className="owner-deletion-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    disabled={pendingId === request.id}
                    onClick={() => setDecision({ request, kind: "reject" })}
                  >
                    {t("ownerAccounts.rejectDeletion")}
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    disabled={pendingId === request.id}
                    onClick={() => setDecision({ request, kind: "approve" })}
                  >
                    <TrashIcon />
                    <span>{t("ownerAccounts.approveDeletion")}</span>
                  </button>
                </footer>
              </article>
            </li>
          ))}
        </ul>
      )}
      {status ? <p role="status">{status}</p> : null}
      {decision ? (
        <ConfirmDialog
          title={t(decision.kind === "approve" ? "ownerAccounts.approveTitle" : "ownerAccounts.rejectTitle", {
            nickname: decision.request.nickname
          })}
          copy={t(decision.kind === "approve" ? "ownerAccounts.approveCopy" : "ownerAccounts.rejectCopy")}
          confirmLabel={t(
            decision.kind === "approve" ? "ownerAccounts.approveDeletion" : "ownerAccounts.rejectDeletion"
          )}
          cancelLabel={t("common.cancel")}
          tone={decision.kind === "approve" ? "danger" : "neutral"}
          onCancel={() => setDecision(null)}
          onConfirm={() => {
            const current = decision;
            setDecision(null);
            setPendingId(current.request.id);
            setStatus("");
            void decideAccountDeletionRequest(current.request.id, current.kind)
              .then(load)
              .catch(() => setStatus(t("ownerAccounts.actionFailed")))
              .finally(() => setPendingId(null));
          }}
        />
      ) : null}
    </section>
  );
}

export function OwnerAccountsSection({
  language,
  timeFormat,
  t
}: {
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "people" | "bots">("all");
  const [loading, setLoading] = useState(true);
  const [loadingAccountId, setLoadingAccountId] = useState<string | null>(null);
  const searchRequest = useRef(0);
  const detailRequest = useRef(0);
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  const accountButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnAccountId = useRef<string | null>(null);
  const [accounts, setAccounts] = useState<OwnerAccount[]>([]);
  const [selected, setSelected] = useState<AccountDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccountDetail | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [permanent, setPermanent] = useState(false);
  const [status, setStatus] = useState("");

  function closeDeleteDialog() {
    setDeleteTarget(null);
    setConfirmation("");
    setPermanent(false);
  }

  function openDeleteDialog(account: AccountDetail) {
    setConfirmation("");
    setPermanent(false);
    setDeleteTarget(account);
  }

  const search = useCallback(
    async (value: string) => {
      const request = ++searchRequest.current;
      ++detailRequest.current;
      setLoadingAccountId(null);
      setLoading(true);
      setStatus("");
      try {
        const results = (await fetchOwnerAccounts(value)).accounts;
        if (request !== searchRequest.current) return;
        setAccounts(results);
        setSelected(null);
      } catch {
        if (request === searchRequest.current) setStatus(t("ownerAccounts.loadFailed"));
      } finally {
        if (request === searchRequest.current) setLoading(false);
      }
    },
    [t]
  );

  const invalidateRequests = useCallback(() => {
    ++searchRequest.current;
    ++detailRequest.current;
  }, []);
  useEffect(() => {
    void search("");
    return invalidateRequests;
  }, [search, invalidateRequests]);

  useEffect(() => {
    if (selected) detailHeading.current?.focus();
    else if (returnAccountId.current) accountButtons.current.get(returnAccountId.current)?.focus();
  }, [selected]);

  // Following a name in the trail lands on the same details view, and the
  // heading takes focus again so the move is announced.
  async function select(accountId: string) {
    const request = ++detailRequest.current;
    if (!selected) returnAccountId.current = accountId;
    setLoadingAccountId(accountId);
    setStatus("");
    try {
      const response = await fetchOwnerAccount(accountId);
      if (request === detailRequest.current) setSelected(response.account);
    } catch {
      if (request === detailRequest.current) setStatus(t("ownerAccounts.loadFailed"));
    } finally {
      if (request === detailRequest.current) setLoadingAccountId(null);
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

  const canDelete =
    selected &&
    selected.role !== "owner" &&
    !selected.isBot &&
    !selected.deletedAt &&
    selected.memberships.every((membership) => membership.role !== "owner");

  const trail: TrailContext = { language, timeFormat, onOpen: (userId) => void select(userId) };

  const visibleAccounts = accounts.filter(
    (account) => filter === "all" || (filter === "bots" ? account.isBot : !account.isBot)
  );
  const accountStatus = (account: OwnerAccount) =>
    t(account.deletedAt ? "ownerAccounts.deletedState" : account.bannedAt ? "common.banned" : "common.active");

  return (
    <section className={`dash-panel owner-accounts-panel ${selected ? "is-detail" : ""}`}>
      {selected ? (
        <>
          <button className="btn btn-ghost accounts-back" type="button" onClick={() => setSelected(null)}>
            <ArrowIcon />
            <span>{t("ownerAccounts.back")}</span>
          </button>
          <header className="account-profile-head">
            <span className="avatar" aria-hidden="true">
              {selected.deletedAt ? "·" : Array.from(selected.nickname)[0]?.toUpperCase()}
            </span>
            <div>
              <h2 ref={detailHeading} tabIndex={-1}>
                {selected.deletedAt ? t("common.deletedMember") : selected.nickname}
              </h2>
              <span className="account-state">{accountStatus(selected)}</span>
              <span className="badge">
                {t(selected.isBot ? "common.bot" : selected.role === "owner" ? "common.owner" : "common.member")}
              </span>
            </div>
          </header>
          <section className="account-membership-section" aria-labelledby="accountMembershipTitle">
            <h3 id="accountMembershipTitle">
              {t("ownerAccounts.memberships")} <span className="badge">{selected.memberships.length}</span>
            </h3>
            <Memberships memberships={selected.memberships} t={t} trail={trail} />
          </section>
          <section className="account-membership-section" aria-labelledby="accountInvitedTitle">
            <h3 id="accountInvitedTitle">{t("ownerAccounts.peopleInvited")}</h3>
            <PeopleInvited groups={selected.invited ?? []} t={t} trail={trail} />
          </section>
          <footer className="account-management-actions">
            {canDelete ? (
              <button className="btn btn-danger" type="button" onClick={() => openDeleteDialog(selected)}>
                <TrashIcon />
                <span>{t("ownerAccounts.deleteNow")}</span>
              </button>
            ) : (
              <p className="muted small">{t("ownerAccounts.protected")}</p>
            )}
          </footer>
        </>
      ) : (
        <>
          <header className="accounts-directory-head">
            <div>
              <h2>
                {t("ownerAccounts.all")} <span className="badge">{visibleAccounts.length}</span>
              </h2>
              <p className="muted small">{t("ownerAccounts.accountsCopy")}</p>
            </div>
          </header>
          <form
            className="owner-account-search"
            onSubmit={(event) => {
              event.preventDefault();
              void search(query);
            }}
          >
            <label className="form-field">
              <span className="visually-hidden">{t("ownerAccounts.search")}</span>
              <input
                className="input"
                placeholder={t("ownerAccounts.search")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <button className="btn" type="submit" disabled={loading}>
              {t("ownerAccounts.searchAction")}
            </button>
          </form>
          <div className="account-directory-filters" role="group" aria-label={t("ownerAccounts.accounts")}>
            {(["all", "people", "bots"] as const).map((value) => (
              <button
                className="btn btn-ghost"
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {t(`ownerAccounts.${value}`)}
              </button>
            ))}
          </div>
          <div className="account-directory" aria-busy={loading}>
            {loading ? (
              <p className="owner-account-empty muted" role="status">
                {t("common.loading")}
              </p>
            ) : visibleAccounts.length > 0 ? (
              visibleAccounts.map((account) => (
                <button
                  className="account-directory-row"
                  type="button"
                  key={account.id}
                  ref={(node) => {
                    if (node) accountButtons.current.set(account.id, node);
                    else accountButtons.current.delete(account.id);
                  }}
                  aria-label={t("ownerAccounts.view", {
                    nickname: account.deletedAt ? t("common.deletedMember") : account.nickname
                  })}
                  aria-busy={loadingAccountId === account.id}
                  onClick={() => void select(account.id)}
                >
                  <span className="avatar" aria-hidden="true">
                    {account.deletedAt ? "·" : Array.from(account.nickname)[0]?.toUpperCase()}
                  </span>
                  <span className="account-directory-identity">
                    <strong>{account.deletedAt ? t("common.deletedMember") : account.nickname}</strong>
                    <span className="muted small">
                      {t(account.isBot ? "common.bot" : account.role === "owner" ? "common.owner" : "common.member")}
                    </span>
                  </span>
                  <span className={`account-state ${account.bannedAt ? "is-banned" : ""}`}>
                    {accountStatus(account)}
                  </span>
                  <span className="account-directory-count muted small">
                    {account.serverCount === 1
                      ? t("ownerAccounts.oneServer")
                      : t("ownerAccounts.serverCount", { count: account.serverCount })}
                  </span>
                  <span className="account-directory-open" aria-hidden="true">
                    {loadingAccountId === account.id ? "…" : <ArrowIcon />}
                  </span>
                </button>
              ))
            ) : (
              <p className="owner-account-empty muted">{t("ownerAccounts.noAccountsFound")}</p>
            )}
          </div>
        </>
      )}
      {status ? <p role="status">{status}</p> : null}
      {deleteTarget ? (
        <div className="confirm-backdrop" role="presentation">
          <form
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t("ownerAccounts.deleteTitle", { nickname: deleteTarget.nickname })}
            onSubmit={submitDelete}
          >
            <h2>{t("ownerAccounts.deleteTitle", { nickname: deleteTarget.nickname })}</h2>
            <p>{t("ownerAccounts.deleteCopy")}</p>
            <label className="form-field">
              <span>{t("accountDeletion.confirmNickname", { nickname: deleteTarget.nickname })}</span>
              <input
                autoFocus
                className="input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={permanent}
                onChange={(event) => setPermanent(event.currentTarget.checked)}
              />
              <span>{t("accountDeletion.permanentConfirm")}</span>
            </label>
            <div className="confirm-actions">
              <button className="btn btn-ghost" type="button" onClick={closeDeleteDialog}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-danger"
                type="submit"
                disabled={confirmation !== deleteTarget.nickname || !permanent}
              >
                <TrashIcon />
                <span>{t("ownerAccounts.deleteNow")}</span>
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
