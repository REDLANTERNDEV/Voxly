import type { ChatMessageReply } from "@voxly/shared";
import type { Translate } from "../../app/types.js";

/**
 * The one-line excerpt above a reply.
 *
 * A reply whose target has been deleted keeps its strip and says so, rather
 * than silently becoming an ordinary message: the answer still reads as an
 * answer, and the reader is told why they cannot follow it.
 */
export function ReplyQuote({
  reply,
  t,
  onJump,
  hideAuthor = false
}: {
  reply: ChatMessageReply | null;
  t: Translate;
  onJump?: (messageId: string) => void;
  /**
   * Set where the surrounding copy already names the author — the composer
   * strip does — so the name is not printed twice on one line.
   */
  hideAuthor?: boolean;
}) {
  if (!reply) {
    return <p className="reply-quote is-missing">{t("room.replyDeleted")}</p>;
  }

  const nickname = reply.authorDeleted ? t("common.deletedMember") : reply.nickname;
  const author = hideAuthor ? null : <span className="reply-quote-author">{nickname}</span>;
  if (!onJump) {
    return (
      <p className="reply-quote">
        {author}
        <span className="reply-quote-body">{reply.body}</span>
      </p>
    );
  }

  const label = t("room.replyJumpTo", { nickname });
  return (
    <button className="reply-quote" type="button" aria-label={label} title={label} onClick={() => onJump(reply.messageId)}>
      {author}
      <span className="reply-quote-body">{reply.body}</span>
    </button>
  );
}
