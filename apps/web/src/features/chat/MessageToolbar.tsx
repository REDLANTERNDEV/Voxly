import type { RefObject } from "react";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import { EditIcon, EmojiIcon, MoreIcon, ReplyIcon } from "../../components/ui/Icons.js";

/**
 * The strip that floats over a message's top-right corner while it is pointed
 * at or focused, as Discord's does: three quick reactions, the picker, edit,
 * reply and the full menu. It never takes width from the text beneath it.
 *
 * One Tab stop for the whole strip; the arrow keys move along it.
 */
export function MessageToolbar(props: {
  t: Translate;
  nickname: string;
  quick: readonly string[];
  /** Emoji this member has already reacted with here: their button removes it. */
  own: ReadonlySet<string>;
  /** At the reaction kind ceiling a new emoji cannot be added, only an existing one joined. */
  existing: ReadonlySet<string>;
  full: boolean;
  canEdit: boolean;
  busy: boolean;
  menuOpen: boolean;
  menuTriggerRef: RefObject<HTMLButtonElement | null>;
  onQuickReact(emoji: string, add: boolean): void;
  onOpenPicker(): void;
  onEdit(): void;
  onReply(): void;
  onOpenMenu(trigger: HTMLButtonElement): void;
}) {
  const { t } = props;
  const [active, setActive] = useState(0);
  const tab = (index: number) => (index === active ? 0 : -1);
  let index = 0;
  const next = () => index++;

  return (
    <div
      className="message-toolbar"
      role="toolbar"
      aria-label={t("chat.messageToolbar", { nickname: props.nickname })}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const target =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        setActive(target);
        buttons[target]?.focus();
      }}
      onFocus={(event) => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const focused = buttons.indexOf(event.target as Element as HTMLButtonElement);
        if (focused >= 0) setActive(focused);
      }}
    >
      {props.quick.map((emoji) => {
        const own = props.own.has(emoji);
        const position = next();
        return (
          <button
            key={emoji}
            type="button"
            className="message-toolbar-emoji"
            tabIndex={tab(position)}
            aria-pressed={own}
            aria-label={t(own ? "chat.quickUnreact" : "chat.quickReact", { emoji })}
            title={t(own ? "chat.quickUnreact" : "chat.quickReact", { emoji })}
            disabled={props.busy || (props.full && !props.existing.has(emoji))}
            onClick={() => props.onQuickReact(emoji, !own)}
          >
            {emoji}
          </button>
        );
      })}
      <span className="message-toolbar-divider" aria-hidden="true" />
      <button
        type="button"
        tabIndex={tab(next())}
        aria-label={t("chat.addReactionPicker")}
        title={t("chat.addReactionPicker")}
        disabled={props.busy}
        onClick={props.onOpenPicker}
      >
        <EmojiIcon />
      </button>
      {props.canEdit ? (
        <button
          type="button"
          tabIndex={tab(next())}
          aria-label={t("common.edit")}
          title={t("common.edit")}
          disabled={props.busy}
          onClick={props.onEdit}
        >
          <EditIcon />
        </button>
      ) : null}
      <button
        type="button"
        className="message-reply-trigger"
        tabIndex={tab(next())}
        aria-label={t("room.replyTo", { nickname: props.nickname })}
        title={t("room.reply")}
        disabled={props.busy}
        onClick={props.onReply}
      >
        <ReplyIcon />
      </button>
      <button
        ref={props.menuTriggerRef}
        type="button"
        className="message-menu-trigger"
        tabIndex={tab(next())}
        aria-label={t("room.messageActions")}
        title={t("room.messageActions")}
        aria-haspopup="menu"
        aria-expanded={props.menuOpen ? "true" : "false"}
        aria-busy={props.busy}
        disabled={props.busy}
        onClick={(event) => props.onOpenMenu(event.currentTarget)}
      >
        <MoreIcon />
      </button>
    </div>
  );
}
