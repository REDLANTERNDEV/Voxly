import { useState } from "react";
import { formatShortDate, inviteLifecycleKey, isInviteRevocable } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { TrashIcon } from "../../components/ui/Icons.js";
import { StatusPill } from "../../components/ui/Primitives.js";
import type { LanguageCode } from "../../lib/i18n.js";
import { inviteReference } from "../../lib/invites.js";
import { daysUntilRemoval } from "../../lib/inviteTrail.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import type { InviteTrailPerson, OwnerInvite } from "../../types.js";

type InviteTableProps = {
  invites: OwnerInvite[];
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onRevoke(invite: OwnerInvite): void;
};

/** The Inviter as owners read it: nickname here and Mention code, or Deleted member. */
export function InviterName({ person, t }: { person: InviteTrailPerson; t: Translate }) {
  if (person.state === "deleted" || person.nickname === null) return <strong>{t("common.deletedMember")}</strong>;
  return (
    <>
      <strong>{person.nickname}</strong>
      {person.mentionCode ? <span className="mono"> #{person.mentionCode}</span> : null}
    </>
  );
}

/**
 * One Server's invites with each one's Invite trail a click away. Owner-only:
 * the server refuses the list to a member holding the invite grant (ADR-0034).
 */
export function OwnerInviteTable({ invites, language, timeFormat, t, onRevoke }: InviteTableProps) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (inviteId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(inviteId)) next.add(inviteId);
      return next;
    });

  return (
    <div className="dash-table is-invites" role="table">
      <div className="dash-table-head" role="row">
        <span role="columnheader">{t("owner.reference")}</span>
        <span role="columnheader">{t("owner.uses")}</span>
        <span role="columnheader">{t("common.expiry")}</span>
        <span role="columnheader">{t("common.actions")}</span>
      </div>
      {invites.map((invite) => {
        const label = invite.label || t("owner.unlabeledInvite");
        const trailId = `invite-trail-${invite.id}`;
        const expanded = open.has(invite.id);
        const removal = daysUntilRemoval(invite);
        return (
          <div className="invite-row-group" role="rowgroup" key={invite.id}>
            <div className="dash-table-row" role="row">
              <span className="dash-cell" role="cell">
                <strong>{label}</strong>
                <span className="mono muted small">{inviteReference(invite.id)}</span>
                <span className="invite-creator small">
                  <span className="muted">{t("owner.createdBy")}</span> <InviterName person={invite.createdBy} t={t} />
                </span>
                <button
                  className="invite-trail-toggle"
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={trailId}
                  onClick={() => toggle(invite.id)}
                >
                  {t("owner.whoJoined", { count: invite.uses.length })}
                </button>
              </span>
              <span className="dash-cell" role="cell">
                <span>
                  {invite.maxUses === null
                    ? t("invite.usedUnlimited", { used: invite.usedCount })
                    : t("invite.usedOfLimit", { used: invite.usedCount, limit: invite.maxUses })}
                </span>
                <StatusPill tone={isInviteRevocable(invite) ? "online" : "warn"}>
                  {t(inviteLifecycleKey(invite))}
                </StatusPill>
              </span>
              <span className="dash-cell" role="cell">
                {formatShortDate(invite.expiresAt, language, t, timeFormat)}
                {removal !== null ? (
                  <span className="muted small">
                    {removal <= 1 ? t("owner.removedSoon") : t("owner.removedInDays", { count: removal })}
                  </span>
                ) : null}
              </span>
              <span className="dash-cell is-actions" role="cell">
                {isInviteRevocable(invite) ? (
                  <button className="btn btn-ghost" type="button" onClick={() => onRevoke(invite)}>
                    <TrashIcon />
                    <span>{t("common.revoke")}</span>
                  </button>
                ) : null}
              </span>
            </div>
            {expanded ? (
              <div className="dash-table-row invite-trail-row" role="row">
                <div className="invite-trail" role="cell" id={trailId}>
                  {invite.uses.length === 0 ? (
                    <p className="muted small">{t("owner.noOneJoined")}</p>
                  ) : (
                    <ul aria-label={t("owner.whoJoinedFor", { invite: label })}>
                      {invite.uses.map((use) => (
                        <li key={use.userId}>
                          <span className="invite-trail-name">
                            <InviterName person={use} t={t} />
                          </span>
                          <span className="muted small">
                            {t("inviteTrail.joined", {
                              date: formatShortDate(use.joinedAt, language, t, timeFormat)
                            })}
                          </span>
                          <span className={`invite-trail-state is-${use.state}`}>
                            {t(`inviteTrail.state.${use.state}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
