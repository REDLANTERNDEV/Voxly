import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { type LanguageCode } from "../../lib/i18n.js";
import { type OutboxEntry } from "../../lib/messageOutbox.js";
import { ReplyQuote } from "./ReplyQuote.js";
import { formatMessageTimestamp } from "../../lib/messages.js";

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
  t,
  onRetry,
  onDiscard
}: {
  entry: OutboxEntry;
  nickname: string;
  language: LanguageCode;
  t: Translate;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}) {
  const hasFailed = entry.status === "failed";
  return (
    <article className={`message message-own message-pending ${hasFailed ? "is-failed" : ""}`}>
      <span className="avatar owner">{initial(nickname)}</span>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{nickname}</span>
          <span className="message-time mono">
            <time dateTime={entry.createdAt}>{formatMessageTimestamp(entry.createdAt, language)}</time>
            <span className="message-pending-state">{hasFailed ? t("room.messageNotSent") : t("common.sending")}</span>
          </span>
        </div>
        {entry.replyTo ? <ReplyQuote reply={entry.replyTo} t={t} /> : null}
        <div className="message-body">{entry.body}</div>
        {hasFailed ? (
          <div className="message-actions">
            <button className="btn btn-ghost" type="button" onClick={() => onRetry(entry.localId)}>{t("room.messageRetry")}</button>
            <button className="btn btn-ghost" type="button" onClick={() => onDiscard(entry.localId)}>{t("room.messageDiscard")}</button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
