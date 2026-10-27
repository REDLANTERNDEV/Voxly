import type { MessageReactionState, PresenceUser } from "@voxly/shared";
import { useState } from "react";
import { ApiError } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { EmojiIcon, MoreIcon, PlusIcon } from "../../components/ui/Icons.js";
import { ChatDialog } from "./ChatDialog.js";
import { EmojiPicker } from "./EmojiPicker.js";
import { rememberEmoji } from "../../lib/recentReactions.js";

export function MessageReactions({
  state,
  userId,
  canModerate,
  members,
  t,
  onReact,
  onClear,
  pickerOpen,
  onPickerChange
}: {
  state: MessageReactionState;
  userId: string;
  canModerate: boolean;
  members: PresenceUser[];
  t: Translate;
  onReact(emoji: string, add: boolean): Promise<void>;
  onClear(emoji: string): Promise<void>;
  /** The picker is the row's, so the message toolbar can open the same one. */
  pickerOpen: boolean;
  onPickerChange(open: boolean): void;
}) {
  const [details, setDetails] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(t(cause instanceof ApiError && cause.status === 409 ? "chat.reactionLimit" : "chat.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  const selected = state.reactions.find((reaction) => reaction.emoji === details);
  return (
    <div className="message-reaction-area">
      <div className="message-reactions" aria-label={t("chat.reactions")}>
        {state.reactions.map((reaction) => {
          const own = reaction.userIds.includes(userId);
          return (
            <div className="reaction-group" key={reaction.emoji}>
              <button
                type="button"
                className="reaction-chip"
                aria-pressed={own}
                aria-busy={busy}
                disabled={busy}
                aria-label={t(own ? "chat.removeOwnReaction" : "chat.addReaction", {
                  emoji: reaction.emoji,
                  count: reaction.userIds.length
                })}
                onClick={() => {
                  if (!own) rememberEmoji(reaction.emoji);
                  void perform(() => onReact(reaction.emoji, !own));
                }}
              >
                <span className="reaction-emoji" aria-hidden="true">
                  {reaction.emoji}
                </span>
                <span className="reaction-count">{reaction.userIds.length}</span>
              </button>
              <button
                type="button"
                className="reaction-details"
                aria-label={t("chat.reactionDetails", { emoji: reaction.emoji })}
                onClick={() => setDetails(reaction.emoji)}
              >
                <MoreIcon />
              </button>
            </div>
          );
        })}
        {/* Beside reactions that already exist, as in Discord. A message with none
            reacts from its toolbar or menu and keeps no empty row for it. */}
        {state.reactions.length > 0 ? (
          <button
            className="reaction-add"
            type="button"
            disabled={busy}
            aria-label={t("chat.addReactionPicker")}
            title={t("chat.addReactionPicker")}
            onClick={() => onPickerChange(true)}
          >
            <EmojiIcon />
            <PlusIcon />
          </button>
        ) : null}
      </div>
      {busy ? (
        <p className="chat-help" role="status">
          {t("common.loading")}…
        </p>
      ) : null}
      {error ? (
        <p className="error-text" role="status">
          {error}
        </p>
      ) : null}
      {pickerOpen ? (
        <EmojiPicker
          t={t}
          reactions={state.reactions}
          onClose={() => onPickerChange(false)}
          onSelect={(emoji) => {
            onPickerChange(false);
            void perform(() =>
              onReact(
                emoji,
                !state.reactions.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(userId))
              )
            );
          }}
        />
      ) : null}
      {details ? (
        <ChatDialog title={t("chat.reactionDetails", { emoji: details })} t={t} onClose={() => setDetails(null)}>
          <ul className="reaction-people">
            {selected?.userIds.map((id) => {
              const member = members.find((person) => person.userId === id);
              return (
                <li key={id}>
                  {member ? `${member.nickname} · #${member.mentionCode ?? ""}` : t("chat.formerMember")}
                </li>
              );
            })}
          </ul>
          {!selected ? <p>{t("chat.noReactions")}</p> : null}
          {canModerate && selected ? (
            <button
              type="button"
              className="btn btn-danger"
              aria-busy={busy}
              disabled={busy}
              onClick={() => {
                void perform(() => onClear(details));
              }}
            >
              {busy ? `${t("common.loading")}…` : t("chat.clearEmojiReactions", { emoji: details })}
            </button>
          ) : null}
          {error ? (
            <p className="error-text" role="status">
              {error}
            </p>
          ) : null}
        </ChatDialog>
      ) : null}
    </div>
  );
}
