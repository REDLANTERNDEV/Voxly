import { auditLogActions, type AuditLogAction, type AuditLogEntry, type PresenceUser } from "@voxly/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAuditLog } from "../../api.js";
import { formatShortDate, initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { EmptyState } from "../../components/ui/Primitives.js";
import { auditFilterKeys, auditRoleChanges, auditSentence } from "../../lib/auditLog.js";
import type { LanguageCode } from "../../lib/i18n.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";

/**
 * Server settings › Audit log (ADR-0039): who changed what in this Server,
 * newest first, filtered by member and by action as Discord's is. The server
 * decides what each reader may see in a line; this only lays it out.
 */
export function ServerAuditLogSection({
  serverId,
  members,
  language,
  timeFormat,
  t
}: {
  serverId: string;
  members: readonly PresenceUser[];
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
}) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState<AuditLogAction | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const request = useRef(0);

  const load = useCallback(
    async (before: string | null) => {
      const id = ++request.current;
      setLoading(true);
      setError(false);
      try {
        const page = await fetchAuditLog(serverId, { before, actorId: actorId || null, action: action || null });
        if (id !== request.current) return;
        setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      } catch {
        if (id === request.current) setError(true);
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [serverId, actorId, action]
  );

  useEffect(() => {
    void load(null);
    return () => {
      request.current += 1;
    };
  }, [load]);

  const people = members.filter((member) => !member.isBot).sort((a, b) => a.nickname.localeCompare(b.nickname));
  const filtered = Boolean(actorId || action);

  return (
    <section className="dash-panel server-settings-panel audit-log">
      <header className="dash-panel-head">
        <p className="muted small">{t("auditLog.copy")}</p>
      </header>
      <div className="audit-log-filters">
        <label className="form-field">
          <span className="label">{t("auditLog.filterMember")}</span>
          <select className="input" value={actorId} onChange={(event) => setActorId(event.currentTarget.value)}>
            <option value="">{t("auditLog.allMembers")}</option>
            {people.map((member) => (
              <option key={member.userId} value={member.userId}>
                {member.nickname}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span className="label">{t("auditLog.filterAction")}</span>
          <select
            className="input"
            value={action}
            onChange={(event) => setAction(event.currentTarget.value as AuditLogAction | "")}
          >
            <option value="">{t("auditLog.allActions")}</option>
            {auditLogActions.map((item) => (
              <option key={item} value={item}>
                {t(auditFilterKeys[item])}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {t("auditLog.loadFailed")}
        </p>
      ) : null}
      {!loading && !error && entries.length === 0 ? (
        filtered ? (
          <p className="muted small">{t("auditLog.emptyFiltered")}</p>
        ) : (
          <EmptyState title={t("auditLog.empty")} copy={t("auditLog.emptyCopy")} />
        )
      ) : null}
      {entries.length > 0 ? (
        <ol className="audit-log-list" aria-busy={loading}>
          {entries.map((entry) => {
            const changes = auditRoleChanges(entry, t, (permission) => t(`permission.${permission}`));
            const actorName = entry.actor?.nickname ?? t("audit.someone");
            return (
              <li className="audit-log-entry" key={entry.id}>
                <span className="avatar" aria-hidden="true">
                  {initial(actorName)}
                </span>
                <div className="audit-log-copy">
                  <p className="audit-log-sentence">
                    {auditSentence(entry, t).map((part, index) =>
                      part.strong ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>
                    )}
                  </p>
                  {changes.length > 0 ? (
                    <ul className="audit-log-changes muted small">
                      {changes.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                  <time className="muted small" dateTime={entry.createdAt}>
                    {formatShortDate(entry.createdAt, language, t, timeFormat)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {nextBefore ? (
        <button
          className="btn btn-ghost audit-log-more"
          type="button"
          disabled={loading}
          onClick={() => void load(nextBefore)}
        >
          {t("auditLog.loadMore")}
        </button>
      ) : null}
    </section>
  );
}
