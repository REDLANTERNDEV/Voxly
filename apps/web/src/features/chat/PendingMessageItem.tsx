import { MessageBody } from "./MessageBody.js";
import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { type LanguageCode } from "../../lib/i18n.js";
import { type OutboxEntry } from "../../lib/messageOutbox.js";
import { ReplyQuote } from "./ReplyQuote.js";
import { formatMessageClock, formatMessageTimestamp } from "../../lib/messages.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";

/**
 * A message the composer has accepted but the server has not acknowledged yet.
 *
 * It deliberately shares none of `MessageItem`'s affordances: an unsent message
 * has no server id, so it cannot be edited, deleted, linkified, or previewed.
 * Only the two recovery actions apply, and only once delivery has failed.
 */
export function PendingMessageItem({
  entry,
  nickname,
  language,
  timeFormat,
  t,
  onRetry,
  onDiscard,
  grouped = false
}: {
  entry: OutboxEntry;
  nickname: string;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
  grouped?: boolean;
}) {
  const hasFailed = entry.status === "failed";
  return (
    <article
      className={`message message-own message-pending ${grouped ? "is-grouped" : ""} ${hasFailed ? "is-failed" : ""}`}
    >
      {grouped ? (
        <span className="message-gutter-time mono" aria-hidden="true">
          {formatMessageClock(entry.createdAt, language, timeFormat)}
        </span>
      ) : (
        <span className="avatar owner">{initial(nickname)}</span>
      )}
      <div className="message-content">
        {/* The sending state stays visible on a grouped row; only the name and time step back. */}
        <div className={`message-meta${grouped ? " is-grouped" : ""}`}>
          <span className={`message-author${grouped ? " sr-only" : ""}`}>{nickname}</span>
          <span className="message-time mono">
            <time dateTime={entry.createdAt} className={grouped ? "sr-only" : undefined}>
              {formatMessageTimestamp(entry.createdAt, language, new Date(), timeFormat)}
            </time>
            <span className="message-pending-state">{hasFailed ? t("room.messageNotSent") : t("common.sending")}</span>
          </span>
        </div>
        {entry.replyTo ? <ReplyQuote reply={entry.replyTo} t={t} /> : null}
        <div className="message-body">
          <MessageBody body={entry.body} mentions={entry.mentions} t={t} links={false} cards={false} />
        </div>
        {hasFailed ? (
          <div className="message-actions">
            <button className="btn btn-ghost" type="button" onClick={() => onRetry(entry.localId)}>
              {t("room.messageRetry")}
            </button>
            <button className="btn btn-ghost" type="button" onClick={() => onDiscard(entry.localId)}>
              {t("room.messageDiscard")}
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
