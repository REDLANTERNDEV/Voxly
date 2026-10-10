import type { ChatMessage, MessageMention, PresenceUser, PublicUser } from "@voxly/shared";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../api.js";
import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CloseIcon, MoreIcon, ReplyIcon } from "../../components/ui/Icons.js";
import { clampContextMenuPosition } from "../../lib/contextMenu.js";
import { type LanguageCode } from "../../lib/i18n.js";
import { messageEmbeds, type MessageEmbed } from "../../lib/messageEmbeds.js";
import {
  formatMessageDateTime,
  formatMessageTimestamp,
  messageDeleteFailureCopy,
  messagePermissions
} from "../../lib/messages.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import type { ExternalPreviewPreferences } from "../../lib/externalPreviewPreferences.js";
import { MessageBody } from "./MessageBody.js";
import { MessageReactions } from "./MessageReactions.js";
import { ChatComposerInput } from "./ChatComposerInput.js";
import { isMentioned, trimMentionDraft, usesNativeMessageMenu } from "../../lib/chatInteractions.js";
import { ReplyQuote } from "./ReplyQuote.js";
import {
  reconcileMentionContent,
  noMemberIdentityChanges,
  type MemberIdentityChanges
} from "../../lib/memberIdentity.js";
export function MessageItem({
  message,
  user,
  language,
  timeFormat,
  externalPreviews,
  t,
  onUpdate,
  onDelete,
  onSuppressEmbed,
  onReply,
  onJumpToMessage,
  onShowEmbedOnce,
  onOpenPrivacySettings,
  revealedEmbedKeys,
  members,
  onlineUsers,
  canPin,
  onPin,
  onReact,
  onClearReactions,
  identityChanges = noMemberIdentityChanges
}: {
  message: ChatMessage;
  user: PublicUser;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  externalPreviews: ExternalPreviewPreferences;
  t: Translate;
  onUpdate: (messageId: string, body: string, mentions: MessageMention[]) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
  onReply: (message: ChatMessage) => void;
  onJumpToMessage: (messageId: string) => void;
  onShowEmbedOnce: (embedKey: string) => void;
  onOpenPrivacySettings: () => void;
  revealedEmbedKeys: ReadonlySet<string>;
  members: PresenceUser[];
  onlineUsers: PresenceUser[];
  canPin: boolean;
  onPin(messageId: string, pinned: boolean): Promise<void>;
  onReact(messageId: string, emoji: string, add: boolean): Promise<void>;
  onClearReactions(messageId: string, emoji?: string): Promise<void>;
  identityChanges?: MemberIdentityChanges;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [draftMentions, setDraftMentions] = useState(message.mentions);
  const resolvedDraft = reconcileMentionContent({ body: draft, mentions: draftMentions }, identityChanges);
  if (resolvedDraft.body !== draft || resolvedDraft.mentions !== draftMentions) {
    setDraft(resolvedDraft.body);
    setDraftMentions(resolvedDraft.mentions);
  }
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingEmbed, setPendingEmbed] = useState<MessageEmbed | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const permissions = messagePermissions({
    currentUserId: user.id,
    currentUserRole: canPin ? "owner" : "member",
    messageUserId: message.userId
  });
  const isOwn = message.userId === user.id;
  const displayNickname = message.authorDeleted ? t("common.deletedMember") : message.nickname;
  // Anyone who can read a message can answer it, so every row has a menu.
  const hasActions = true;
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
    setMenuPosition(
      clampContextMenuPosition({
        x,
        y,
        menuWidth: 160,
        menuHeight: 50 + (permissions.canEdit ? 42 : 0) + (permissions.canDelete ? 42 : 0) + (canPin ? 84 : 0),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    );
  }

  async function saveEdit() {
    const retainedIds = new Set(message.mentions.map((mention) => mention.id));
    const { body, mentions } = trimMentionDraft(
      draft,
      draftMentions.filter((mention) => !mention.authorDeleted || retainedIds.has(mention.id))
    );
    if (!body) return;
    setIsBusy(true);
    setActionError("");
    try {
      await onUpdate(message.id, body, mentions);
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
      className={`message ${isOwn ? "message-own" : ""} ${isMentioned(message, user.id) ? "message-mentioned" : ""}`}
      onContextMenu={
        hasActions
          ? (event) => {
              if (usesNativeMessageMenu(event.target)) {
                setMenuPosition(null);
                return;
              }
              event.preventDefault();
              openMenu(event.clientX, event.clientY);
            }
          : undefined
      }
    >
      <span className={`avatar ${isOwn ? "owner" : ""}`}>
        {message.authorDeleted ? "—" : initial(message.nickname)}
      </span>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{displayNickname}</span>
          {message.pinnedAt ? <span className="message-pin-label">{t("chat.pinned")}</span> : null}
          {isMentioned(message, user.id) ? <span className="sr-only">{t("chat.mentioned")}</span> : null}
          <span className="message-time mono">
            <time dateTime={message.createdAt}>
              {formatMessageTimestamp(message.createdAt, language, new Date(), timeFormat)}
            </time>
            {message.editedAt ? (
              <span
                className="message-edited"
                title={t("room.editedAt", { time: formatMessageDateTime(message.editedAt, language, timeFormat) })}
              >
                ({t("status.edited")})
              </span>
            ) : null}
          </span>
        </div>
        {message.replyToMessageId ? (
          <ReplyQuote
            reply={message.replyTo}
            t={t}
            onJump={onJumpToMessage}
            members={members}
            onlineUsers={onlineUsers}
          />
        ) : null}
        {isEditing ? (
          <div className="message-edit">
            <ChatComposerInput
              label={t("common.edit")}
              body={draft}
              mentions={draftMentions}
              onChange={(body, mentions) => {
                setDraft(body);
                setDraftMentions(mentions);
              }}
              members={members}
              onlineUsers={onlineUsers}
              t={t}
              onSubmit={() => {
                if (!isBusy) void saveEdit();
              }}
              onEscape={() => setIsEditing(false)}
            />
            <div className="message-actions">
              <button className="btn btn-primary" type="button" disabled={isBusy} onClick={saveEdit}>
                {t("common.save")}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                disabled={isBusy}
                onClick={() => {
                  setDraft(message.body);
                  setDraftMentions(message.mentions);
                  setIsEditing(false);
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="message-body">
              <MessageBody
                body={message.body}
                mentions={message.mentions}
                members={members}
                onlineUsers={onlineUsers}
                t={t}
              />
            </div>
            {embeds.length > 0 ? (
              <div className="message-rich-embeds">
                {embeds.map((embed) => {
                  const provider = embedProviderLabel(embed.provider);
                  const previewEnabled = externalPreviews[embed.provider] || revealedEmbedKeys.has(embed.key);
                  return (
                    <section className={`message-embed is-${embed.provider}`} key={embed.key}>
                      <header className="message-embed-head">
                        <a href={embed.sourceUrl} target="_blank" rel="noopener noreferrer">
                          {provider}
                        </a>
                        {permissions.canDelete ? (
                          <button
                            className="message-embed-close"
                            type="button"
                            aria-label={t("room.suppressEmbed", { provider })}
                            title={t("room.suppressEmbed", { provider })}
                            disabled={isBusy}
                            onClick={() => setPendingEmbed(embed)}
                          >
                            <CloseIcon />
                          </button>
                        ) : null}
                      </header>
                      {previewEnabled ? (
                        <iframe
                          src={embed.embedUrl}
                          title={t("room.embedTitle", { provider })}
                          loading="lazy"
                          referrerPolicy="strict-origin-when-cross-origin"
                          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
                          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                          allowFullScreen
                        />
                      ) : (
                        <div className="message-embed-disabled">
                          <span>{t("room.previewOff")}</span>
                          <span aria-hidden="true">·</span>
                          <button type="button" onClick={() => onShowEmbedOnce(embed.key)}>
                            {t("room.previewShowOnce")}
                          </button>
                          <span aria-hidden="true">·</span>
                          <button type="button" onClick={onOpenPrivacySettings}>
                            {t("room.previewSettings")}
                          </button>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
        {!isEditing ? (
          <MessageReactions
            state={message.reactionState}
            userId={user.id}
            canModerate={canPin}
            members={members}
            t={t}
            onReact={(emoji, add) => onReact(message.id, emoji, add)}
            onClear={(emoji) => onClearReactions(message.id, emoji)}
          />
        ) : null}
        {isBusy ? (
          <p className="chat-help" role="status">
            {t("common.loading")}…
          </p>
        ) : null}
        {actionError ? (
          <p className="error-text" aria-live="polite">
            {actionError}
          </p>
        ) : null}
      </div>
      {!isEditing && hasActions ? (
        <button
          className="message-reply-trigger"
          type="button"
          aria-label={t("room.replyTo", { nickname: displayNickname })}
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
          aria-busy={isBusy}
          disabled={isBusy}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right - 160, rect.bottom + 4);
          }}
        >
          <MoreIcon />
        </button>
      ) : null}
      {menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              className="message-context-menu"
              role="menu"
              aria-label={t("room.messageActions")}
              style={{ left: menuPosition.x, top: menuPosition.y }}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuPosition(null);
                  onReply(message);
                }}
              >
                {t("room.reply")}
              </button>
              {permissions.canEdit ? (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuPosition(null);
                    setDraft(message.body);
                    setDraftMentions(message.mentions);
                    setIsEditing(true);
                  }}
                >
                  {t("common.edit")}
                </button>
              ) : null}
              {canPin ? (
                <>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isBusy}
                    onClick={() => {
                      setMenuPosition(null);
                      setIsBusy(true);
                      setActionError("");
                      void onPin(message.id, !message.pinnedAt)
                        .catch(() => setActionError(t("chat.actionFailed")))
                        .finally(() => setIsBusy(false));
                    }}
                  >
                    {t(message.pinnedAt ? "chat.unpin" : "chat.pin")}
                  </button>
                  <button
                    role="menuitem"
                    type="button"
                    disabled={isBusy || message.reactionState.reactions.length === 0}
                    onClick={() => {
                      setMenuPosition(null);
                      setIsBusy(true);
                      setActionError("");
                      void onClearReactions(message.id)
                        .catch(() => setActionError(t("chat.actionFailed")))
                        .finally(() => setIsBusy(false));
                    }}
                  >
                    {t("chat.clearAllReactions")}
                  </button>
                </>
              ) : null}
              {permissions.canDelete ? (
                <button
                  className="is-danger"
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuPosition(null);
                    setConfirmingDelete(true);
                  }}
                >
                  {t("common.delete")}
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
      {confirmingDelete ? (
        <ConfirmDialog
          cancelLabel={t("common.cancel")}
          title={t("room.deleteMessageConfirm")}
          copy={t("room.deleteMessageCopy")}
          confirmLabel={t("common.delete")}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setConfirmingDelete(false);
            void deleteCurrentMessage();
          }}
        />
      ) : null}
      {pendingEmbed ? (
        <ConfirmDialog
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
        />
      ) : null}
    </article>
  );
}

export function embedProviderLabel(provider: MessageEmbed["provider"]) {
  if (provider === "youtube") return "YouTube";
  if (provider === "x") return "X / Twitter";
  if (provider === "vimeo") return "Vimeo";
  return "Spotify";
}
