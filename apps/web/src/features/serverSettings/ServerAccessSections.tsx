import { useState } from "react";
import { createAccessLink, revokeServerInvite } from "../../api.js";
import { formatShortDate, isInviteRevocable } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CopyIcon, LinkIcon } from "../../components/ui/Icons.js";
import { EmptyState, MemberRow } from "../../components/ui/Primitives.js";
import type { LanguageCode } from "../../lib/i18n.js";
import { resolveInviteOrigin } from "../../lib/invites.js";
import { partitionInvites } from "../../lib/inviteTrail.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import type { OwnerInvite, ServerMember } from "../../types.js";
import { OwnerInviteTable } from "../owner/OwnerInviteTable.js";
import { SecretLinkDisplay } from "../owner/OwnerServerContext.js";

/**
 * Server settings › Invite trail, the owner's alone (ADR-0034): every Invite
 * with who made it and who joined through it, active ones revocable, past
 * ones folded away.
 */
export function ServerInviteTrailSection({
  serverId,
  invites,
  language,
  timeFormat,
  t,
  onChanged,
  onError
}: {
  serverId: string;
  invites: OwnerInvite[];
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [revoking, setRevoking] = useState<OwnerInvite | null>(null);
  const { active, past } = partitionInvites(invites);
  return (
    <section className="dash-panel server-settings-panel">
      <header className="dash-panel-head">
        <p className="muted small">
          {t("owner.inviteTableCopy")}{" "}
          {t("serverSettings.activeInvites", { count: invites.filter(isInviteRevocable).length })}
        </p>
      </header>
      {invites.length === 0 ? (
        <EmptyState title={t("owner.noInvites")} copy={t("owner.noInvitesCopy")} />
      ) : (
        <>
          {active.length === 0 ? (
            <p className="muted small">{t("owner.noActiveInvites")}</p>
          ) : (
            <OwnerInviteTable
              invites={active}
              language={language}
              timeFormat={timeFormat}
              t={t}
              onRevoke={setRevoking}
            />
          )}
          {past.length > 0 ? (
            <details className="past-invites">
              <summary>{t("owner.pastInvites", { count: past.length })}</summary>
              <p className="muted small">{t("owner.pastInvitesCopy")}</p>
              <OwnerInviteTable
                invites={past}
                language={language}
                timeFormat={timeFormat}
                t={t}
                onRevoke={setRevoking}
              />
            </details>
          ) : null}
        </>
      )}
      {revoking ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          title={t("owner.revokeInviteTitle")}
          copy={t("owner.revokeConfirm")}
          confirmLabel={t("common.revoke")}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const invite = revoking;
            setRevoking(null);
            void revokeServerInvite(serverId, invite.id)
              .then(onChanged)
              .catch(() => onError(t("owner.actionFailed")));
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Server settings › Access links, the owner's alone for good: a one-time way
 * back into an Account, which is why nobody else may mint one (decision 10).
 */
export function ServerAccessLinksSection({
  serverId,
  users,
  publicUrl,
  language,
  timeFormat,
  t,
  onError
}: {
  serverId: string;
  users: ServerMember[];
  publicUrl: string | null;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onError: (message: string) => void;
}) {
  const [accessLink, setAccessLink] = useState<{ nickname: string; token: string; expiresAt: string } | null>(null);
  // A Bot cannot open a browser, an owner has their own way in, and a banned
  // member is refused on the server; none of them is offered a link.
  const people = users.filter((member) => !member.isBot && member.role !== "owner" && !member.bannedAt);
  const accessLinkUrl = accessLink
    ? `${resolveInviteOrigin(publicUrl, window.location.origin)}/access/claim#token=${accessLink.token}`
    : "";
  return (
    <section className="dash-panel server-settings-panel">
      <header className="dash-panel-head">
        <p className="muted small">{t("serverSettings.accessLinksCopy")}</p>
      </header>
      {accessLink ? (
        <div className="dash-callout" aria-live="polite">
          <strong>{t("owner.accessLinkFor", { nickname: accessLink.nickname })}</strong>
          <SecretLinkDisplay key={accessLinkUrl} value={accessLinkUrl} t={t} />
          <p className="muted small">
            {t("owner.accessLinkCopy", { expiry: formatShortDate(accessLink.expiresAt, language, t, timeFormat) })}
          </p>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(accessLinkUrl)}
          >
            <CopyIcon />
            <span>{t("common.copy")}</span>
          </button>
        </div>
      ) : null}
      {people.length === 0 ? (
        <p className="muted small">{t("serverSettings.accessLinksEmpty")}</p>
      ) : (
        <ul className="server-settings-list">
          {people.map((member) => (
            <li key={member.id}>
              <MemberRow user={member.nickname} detail={t("shell.memberSession")} />
              <button
                className="btn btn-ghost"
                type="button"
                aria-label={t("serverSettings.accessLinkFor", { nickname: member.nickname })}
                onClick={() => {
                  void createAccessLink(serverId, member.id)
                    .then((response) =>
                      setAccessLink({ nickname: member.nickname, token: response.token, expiresAt: response.expiresAt })
                    )
                    .catch(() => onError(t("owner.accessLinkFailed")));
                }}
              >
                <LinkIcon />
                <span>{t("owner.accessLink")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
