import { chatEmojiCatalog, maxMessageReactionKinds, type MessageReaction } from "@voxly/shared";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import { ChatDialog } from "./ChatDialog.js";

export function EmojiPicker({
  t,
  onSelect,
  onClose,
  reactions
}: {
  t: Translate;
  onSelect(emoji: string): void;
  onClose(): void;
  reactions?: MessageReaction[];
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const full = Boolean(reactions && reactions.length >= maxMessageReactionKinds);
  const categories = ["all", "faces", "gestures", "symbols", "activities", "nature", "food", "objects"] as const;
  const visible = chatEmojiCatalog.filter(
    ([emoji, group, en, tr]) =>
      (category === "all" || category === group) &&
      `${emoji} ${en} ${tr}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  return (
    <ChatDialog title={t("chat.emojiPicker")} onClose={onClose} t={t}>
      <input
        className="input"
        aria-label={t("chat.emojiSearch")}
        placeholder={t("chat.emojiSearch")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="emoji-categories" aria-label={t("chat.emojiCategories")}>
        {categories.map((value) => (
          <button type="button" key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>
            {t(`chat.emoji.${value}`)}
          </button>
        ))}
      </div>
      {full ? (
        <p className="chat-help" role="status">
          {t("chat.reactionLimit")}
        </p>
      ) : null}
      <div className="emoji-grid">
        {visible.map(([emoji, , en, tr]) => (
          <button
            type="button"
            key={emoji}
            disabled={full && !reactions?.some((reaction) => reaction.emoji === emoji)}
            aria-label={`${emoji} ${en} / ${tr}`}
            title={`${en} / ${tr}`}
            onClick={() => onSelect(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {!visible.length ? <p>{t("chat.noResults")}</p> : null}
    </ChatDialog>
  );
}
