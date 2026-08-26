import type { ChatMessage,PublicUser } from "@voxly/shared";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../api.js";
import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CloseIcon,MoreIcon,ReplyIcon } from "../../components/ui/Icons.js";
import { clampContextMenuPosition } from "../../lib/contextMenu.js";
import { type LanguageCode } from "../../lib/i18n.js";
import { messageContentSegments,messageEmbeds,type MessageEmbed } from "../../lib/messageEmbeds.js";
import { formatMessageDateTime,formatMessageTimestamp,messageDeleteFailureCopy,messagePermissions } from "../../lib/messages.js";
import { ReplyQuote } from "./ReplyQuote.js";
export function MessageItem({
  message,
  user,
  language,
  t,
  onUpdate,
  onDelete,
  onSuppressEmbed,
  onReply,
  onJumpToMessage
}: {
  message: ChatMessage;
  user: PublicUser;
  language: LanguageCode;
  t: Translate;
  onUpdate: (messageId: string, body: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
  onReply: (message: ChatMessage) => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingEmbed, setPendingEmbed] = useState<MessageEmbed | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const permissions = messagePermissions({
    currentUserId: user.id,
    currentUserRole: user.role,
    messageUserId: message.userId
  });
  const isOwn = message.userId === user.id;
  // Anyone who can read a message can answer it, so every row has a menu.
  const hasActions = true;
  const contentSegments = messageContentSegments(message.body);
  const embeds = messageEmbeds(message.body, message.suppressedEmbedKeys);

  useEffect(() => {
    if (!menuPosition) return;

    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPosition(null);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuPosition(null);
      menuTriggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuPosition]);

  function openMenu(x: number, y: number) {
    setMenuPosition(clampContextMenuPosition({
      x,
      y,
      menuWidth: 160,
      menuHeight: 50 + (permissions.canEdit ? 42 : 0) + (permissions.canDelete ? 42 : 0),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    }));
  }

  async function saveEdit() {
    const body = draft.trim();
    if (!body) return;
    setIsBusy(true);
    setActionError("");
    try {
      await onUpdate(message.id, body);
      setIsEditing(false);
    } catch {
      setActionError(t("room.messageCouldNotSend"));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteCurrentMessage() {
    setIsBusy(true);
    setActionError("");
    try {
      await onDelete(message.id);
    } catch (error) {
      setActionError(messageDeleteFailureCopy(error instanceof ApiError ? error.status : undefined, t));
    } finally {
      setIsBusy(false);
    }
  }

  async function suppressCurrentEmbed(embed: MessageEmbed) {
    setIsBusy(true);
    setActionError("");
    try {
      await onSuppressEmbed(message.id, embed.key);
    } catch {
      setActionError(t("room.suppressEmbedError"));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <article
      data-message-id={message.id}
      className={`message ${isOwn ? "message-own" : ""}`}
      onContextMenu={hasActions ? (event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      } : undefined}
    >
      <span className={`avatar ${isOwn ? "owner" : ""}`}>{initial(message.nickname)}</span>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{message.nickname}</span>
          <span className="message-time mono">
            <time dateTime={message.createdAt}>{formatMessageTimestamp(message.createdAt, language)}</time>
            {message.editedAt ? (
              <span
                className="message-edited"
                title={t("room.editedAt", { time: formatMessageDateTime(message.editedAt, language) })}
              >({t("status.edited")})</span>
            ) : null}
          </span>
        </div>
        {message.replyToMessageId ? (
          <ReplyQuote reply={message.replyTo} t={t} onJump={onJumpToMessage} />
        ) : null}
        {isEditing ? (
          <div className="message-edit">
            <textarea className="textarea" aria-label={t("common.edit")} value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} />
            <div className="message-actions">
              <button className="btn btn-primary" type="button" disabled={isBusy} onClick={saveEdit}>{t("common.save")}</button>
              <button className="btn btn-ghost" type="button" disabled={isBusy} onClick={() => { setDraft(message.body); setIsEditing(false); }}>{t("common.cancel")}</button>
            </div>
          </div>
        ) : (
          <>
            <div className="message-body">{contentSegments.map((segment, index) => segment.kind === "link" ? (
              <a href={segment.href} target="_blank" rel="noopener noreferrer" key={`${segment.href}:${index}`}>{segment.text}</a>
            ) : <span key={`text:${index}`}>{segment.text}</span>)}</div>
            {embeds.length > 0 ? <div className="message-rich-embeds">
              {embeds.map((embed) => {
                const provider = embedProviderLabel(embed.provider);
                return <section className={`message-embed is-${embed.provider}`} key={embed.key}>
                  <header className="message-embed-head">
                    <a href={embed.sourceUrl} target="_blank" rel="noopener noreferrer">{provider}</a>
                    {permissions.canDelete ? <button
                      className="message-embed-close"
                      type="button"
                      aria-label={t("room.suppressEmbed", { provider })}
                      title={t("room.suppressEmbed", { provider })}
                      disabled={isBusy}
                      onClick={() => setPendingEmbed(embed)}
                    ><CloseIcon /></button> : null}
                  </header>
                  <iframe
                    src={embed.embedUrl}
                    title={t("room.embedTitle", { provider })}
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
                    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                    allowFullScreen
                  />
                </section>;
              })}
            </div> : null}
          </>
        )}
        {actionError ? <p className="error-text" aria-live="polite">{actionError}</p> : null}
      </div>
      {!isEditing && hasActions ? (
        <button
          className="message-reply-trigger"
          type="button"
          aria-label={t("room.replyTo", { nickname: message.nickname })}
          title={t("room.reply")}
          disabled={isBusy}
          onClick={() => onReply(message)}
        >
          <ReplyIcon />
        </button>
      ) : null}
      {hasActions ? (
        <button
          ref={menuTriggerRef}
          className="message-menu-trigger"
          type="button"
          aria-label={t("room.messageActions")}
          aria-haspopup="menu"
          aria-expanded={menuPosition ? "true" : "false"}
          disabled={isBusy}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right - 160, rect.bottom + 4);
          }}
        >
          <MoreIcon />
        </button>
      ) : null}
      {menuPosition ? createPortal(
        <div
          ref={menuRef}
          className="message-context-menu"
          role="menu"
          aria-label={t("room.messageActions")}
          style={{ left: menuPosition.x, top: menuPosition.y }}
        >
          <button role="menuitem" type="button" onClick={() => {
            setMenuPosition(null);
            onReply(message);
          }}>{t("room.reply")}</button>
          {permissions.canEdit ? (
            <button role="menuitem" type="button" onClick={() => {
              setMenuPosition(null);
              setDraft(message.body);
              setIsEditing(true);
            }}>{t("common.edit")}</button>
          ) : null}
          {permissions.canDelete ? (
            <button className="is-danger" role="menuitem" type="button" onClick={() => {
              setMenuPosition(null);
              setConfirmingDelete(true);
            }}>{t("common.delete")}</button>
          ) : null}
        </div>,
        document.body
      ) : null}
      {confirmingDelete ? <ConfirmDialog cancelLabel={t("common.cancel")}
        title={t("room.deleteMessageConfirm")}
        copy={t("room.deleteMessageCopy")}
        confirmLabel={t("common.delete")}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          void deleteCurrentMessage();
        }}
      /> : null}
      {pendingEmbed ? <ConfirmDialog
        title={t("room.suppressEmbedTitle")}
        copy={t("room.suppressEmbedCopy")}
        confirmLabel={t("room.suppressEmbedConfirm")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setPendingEmbed(null)}
        onConfirm={() => {
          const embed = pendingEmbed;
          setPendingEmbed(null);
          void suppressCurrentEmbed(embed);
        }}
      /> : null}
    </article>
  );
}

export function embedProviderLabel(provider: MessageEmbed["provider"]) {
  if (provider === "youtube") return "YouTube";
  if (provider === "x") return "X / Twitter";
  if (provider === "vimeo") return "Vimeo";
  return "Spotify";
}
