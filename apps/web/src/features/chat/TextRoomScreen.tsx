import type { ChatMessage, ChatMessageReply, MessageMention } from "@voxly/shared";
import type { FormEvent } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { serverPath } from "../../app/navigation.js";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { ArrowIcon, CloseIcon, ReplyIcon } from "../../components/ui/Icons.js";
import { EmptyState, RoomHeader } from "../../components/ui/Primitives.js";
import { resolveRememberedRoom } from "../../lib/channelState.js";
import { isMessageListNearBottom, messageListUpdateAction } from "../../lib/messages.js";
import { messageListIds, type OutboxEntry } from "../../lib/messageOutbox.js";
import { requestSettingsSection } from "../../lib/settingsNavigation.js";
import { MessageItem } from "./MessageItem.js";
import { PendingMessageItem } from "./PendingMessageItem.js";
import { ChatComposerInput } from "./ChatComposerInput.js";
import { PinnedMessages } from "./PinnedMessages.js";
import { trimMentionDraft } from "../../lib/chatInteractions.js";
import { ReplyQuote } from "./ReplyQuote.js";
import {
  reconcileMentionContent,
  reconcileReplyIdentity,
  type MemberIdentityChanges
} from "../../lib/memberIdentity.js";
type TextRoomProps = Pick<
  ShellModel,
  | "user"
  | "language"
  | "timeFormat"
  | "externalPreviews"
  | "t"
  | "currentRoom"
  | "rooms"
  | "roomHistory"
  | "activeServerId"
  | "serverMembers"
  | "onlineUsers"
> &
  Pick<ShellActions, "onNavigate"> & {
    messages: ChatMessage[];
    contextMessages: ChatMessage[] | null;
    pinRevision: number;
    identityChanges: MemberIdentityChanges;
    canPin: boolean;
    onOpenContext(messageId: string): Promise<void>;
    onBackToLatest(): Promise<void>;
    onPin(messageId: string, pinned: boolean): Promise<void>;
    onReact(messageId: string, emoji: string, add: boolean): Promise<void>;
    onClearReactions(messageId: string, emoji?: string): Promise<void>;
    outbox: OutboxEntry[];
    onSendMessage: (body: string, replyTo: ChatMessageReply | null, mentions: MessageMention[]) => void;
    onRetrySend: (localId: string) => void;
    onDiscardSend: (localId: string) => void;
    onUpdateMessage: (messageId: string, body: string, mentions: MessageMention[]) => Promise<void>;
    onDeleteMessage: (messageId: string) => Promise<void>;
    onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
  };

export function TextRoomScreen(props: TextRoomProps) {
  const [draft, setDraft] = useState("");
  const [draftMentions, setDraftMentions] = useState<MessageMention[]>([]);
  const [showPins, setShowPins] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const displayedMessages = props.contextMessages ?? props.messages;
  const [replyTarget, setReplyTarget] = useState<ChatMessageReply | null>(null);
  const resolvedDraft = reconcileMentionContent({ body: draft, mentions: draftMentions }, props.identityChanges);
  if (resolvedDraft.body !== draft || resolvedDraft.mentions !== draftMentions) {
    setDraft(resolvedDraft.body);
    setDraftMentions(resolvedDraft.mentions);
  }
  const resolvedReply = replyTarget ? reconcileReplyIdentity(replyTarget, props.identityChanges) : null;
  if (resolvedReply !== replyTarget) setReplyTarget(resolvedReply);
  const [error, setError] = useState("");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [revealedEmbeds, setRevealedEmbeds] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const previousMessageIdsRef = useRef<string[]>([]);
  const roomId = props.currentRoom?.id;
  const targetVoiceRoom = resolveRememberedRoom(props.rooms.voice, props.roomHistory[props.activeServerId]?.voice);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  useLayoutEffect(() => {
    const field = composerRef.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "0px";
      const style = getComputedStyle(field);
      const line = parseFloat(style.lineHeight) || 21;
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const limit = Math.min(line * (window.innerWidth <= 560 ? 6 : 15) + padding, window.innerHeight * 0.4);
      field.style.height = `${Math.min(field.scrollHeight, limit)}px`;
      field.style.overflowY = field.scrollHeight > limit ? "auto" : "hidden";
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draft]);

  useLayoutEffect(() => {
    previousMessageIdsRef.current = messageListIds(
      displayedMessages.map((message) => message.id),
      props.outbox
    );
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
    scrollToLatest("auto");
    setRevealedEmbeds(new Set());
  }, [roomId, scrollToLatest]);

  useLayoutEffect(() => {
    const currentIds = messageListIds(
      displayedMessages.map((message) => message.id),
      props.outbox
    );
    if (props.contextMessages !== null) return;
    const action = messageListUpdateAction(previousMessageIdsRef.current, currentIds, wasNearBottomRef.current);
    previousMessageIdsRef.current = currentIds;
    if (action === "scroll") scrollToLatest("auto");
    if (action === "notify") setHasNewMessages(true);
  }, [displayedMessages, props.contextMessages, props.outbox, scrollToLatest]);

  function handleListScroll() {
    const list = listRef.current;
    if (!list) return;
    const isNearBottom = isMessageListNearBottom(list);
    wasNearBottomRef.current = isNearBottom;
    if (isNearBottom) setHasNewMessages(false);
  }

  // The composer hands the draft to the outbox and clears immediately. Delivery
  // failures surface on the message's own row, so nothing here blocks the next
  // keystroke or the next Enter.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { body, mentions } = trimMentionDraft(
      draft,
      draftMentions.filter((mention) => !mention.authorDeleted)
    );
    if (!body) {
      setError(props.t("room.writeBeforeSending"));
      return;
    }

    setError("");
    setDraft("");
    setDraftMentions([]);
    props.onSendMessage(body, replyTarget, mentions);
    setReplyTarget(null);
  }

  function startReply(message: ChatMessage) {
    setReplyTarget({
      messageId: message.id,
      userId: message.userId,
      nickname: message.nickname,
      authorDeleted: message.authorDeleted,
      body: message.body,
      mentions: message.mentions
    });
    composerRef.current?.focus();
  }

  // Highlighting rather than only scrolling: in a dense room the jump alone
  // leaves the reader hunting for which line they were sent to.
  function jumpToMessage(messageId: string) {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) {
      setContextBusy(true);
      setError("");
      void props
        .onOpenContext(messageId)
        .then(() => setJumpTarget(messageId))
        .catch(() => setError(props.t("chat.contextError")))
        .finally(() => setContextBusy(false));
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-jump-target");
    // Re-trigger the animation when the same message is jumped to twice.
    void target.offsetWidth;
    target.classList.add("is-jump-target");
  }

  useLayoutEffect(() => {
    if (!jumpTarget) return;
    const target = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTarget)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "auto", block: "center" });
    target.classList.add("is-jump-target");
    setJumpTarget(null);
  }, [displayedMessages, jumpTarget]);

  return (
    <main className="main-panel" id="main-content">
      <RoomHeader
        title={props.currentRoom?.name ?? "lobby"}
        actions={
          <button className="btn btn-ghost" type="button" aria-haspopup="dialog" onClick={() => setShowPins(true)}>
            {props.t("chat.pins")}
          </button>
        }
        subtitle={props.t("room.generalTalk")}
        actionLabel={targetVoiceRoom ? props.t("room.openChannel", { channel: targetVoiceRoom.name }) : undefined}
        onAction={
          targetVoiceRoom
            ? () => props.onNavigate(serverPath(props.activeServerId, "voice", targetVoiceRoom.id))
            : undefined
        }
      />
      <div className="message-viewport chat-message-viewport">
        <div className={`chat-history-controls${props.contextMessages !== null ? " is-history" : ""}`}>
          <button
            className="btn btn-ghost chat-phone-pins"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setShowPins(true)}
          >
            {props.t("chat.pins")}
          </button>
          {props.contextMessages !== null ? (
            <button
              className="btn btn-ghost"
              type="button"
              disabled={contextBusy}
              onClick={() => {
                setContextBusy(true);
                setError("");
                void props
                  .onBackToLatest()
                  .then(() => requestAnimationFrame(() => scrollToLatest("auto")))
                  .catch(() => setError(props.t("chat.actionFailed")))
                  .finally(() => setContextBusy(false));
              }}
            >
              {props.t("chat.backToLatest")}
            </button>
          ) : null}
        </div>
        <section
          className="message-list"
          ref={listRef}
          aria-label={props.t("room.messages")}
          onScroll={handleListScroll}
        >
          <div className="message-day">{props.t("room.today")}</div>
          {displayedMessages.length === 0 && props.outbox.length === 0 ? (
            <EmptyState title={props.t("room.noMessages")} copy={props.t("room.noMessagesCopy")} />
          ) : (
            displayedMessages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                user={props.user}
                members={props.serverMembers}
                onlineUsers={props.onlineUsers}
                canPin={props.canPin}
                identityChanges={props.identityChanges}
                onPin={props.onPin}
                onReact={props.onReact}
                onClearReactions={props.onClearReactions}
                language={props.language}
                timeFormat={props.timeFormat}
                externalPreviews={props.externalPreviews}
                t={props.t}
                onUpdate={props.onUpdateMessage}
                onDelete={props.onDeleteMessage}
                onSuppressEmbed={props.onSuppressEmbed}
                onReply={startReply}
                onJumpToMessage={jumpToMessage}
                onShowEmbedOnce={(embedKey) => setRevealedEmbeds((current) => new Set(current).add(embedKey))}
                onOpenPrivacySettings={() => requestSettingsSection("privacy")}
                revealedEmbedKeys={revealedEmbeds}
              />
            ))
          )}
          {props.outbox.map((entry) => (
            <PendingMessageItem
              key={entry.localId}
              entry={entry}
              nickname={props.user.nickname}
              language={props.language}
              timeFormat={props.timeFormat}
              t={props.t}
              onRetry={props.onRetrySend}
              onDiscard={props.onDiscardSend}
            />
          ))}
        </section>
        {hasNewMessages ? (
          <button className="new-messages-indicator" type="button" onClick={() => scrollToLatest()}>
            {props.t("room.newMessages")}
            <ArrowIcon />
          </button>
        ) : null}
      </div>
      <footer
        className="composer"
        onClick={(event) => {
          if (
            event.button === 0 &&
            event.target instanceof Element &&
            !event.target.closest("button, a, input, textarea, select, [role=button], .composer-reply")
          ) {
            // A click on the surrounding box also starts typing. Wait for the
            // click so an earlier text selection cannot block this gesture.
            composerRef.current?.focus();
          }
        }}
      >
        {replyTarget ? (
          <div className="composer-reply">
            <span className="composer-reply-label" aria-hidden="true">
              <ReplyIcon />
            </span>
            <span className="composer-reply-target">
              {props.t("room.replyingTo", {
                nickname: replyTarget.authorDeleted ? props.t("common.deletedMember") : replyTarget.nickname
              })}
            </span>
            <ReplyQuote
              reply={replyTarget}
              t={props.t}
              hideAuthor
              members={props.serverMembers}
              onlineUsers={props.onlineUsers}
            />
            <button
              className="icon-btn"
              type="button"
              aria-label={props.t("room.replyCancel")}
              title={props.t("room.replyCancel")}
              onClick={() => {
                setReplyTarget(null);
                composerRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          </div>
        ) : null}
        <form onSubmit={submit}>
          <label className="form-field" htmlFor="messageInput">
            <span className="label composer-field-label">
              {props.t("room.messageLabel", { room: props.currentRoom?.name ?? "lobby" })}
            </span>
            <ChatComposerInput
              inputRef={composerRef}
              id="messageInput"
              label={props.t("room.messageLabel", { room: props.currentRoom?.name ?? "lobby" })}
              placeholder={props.t("room.chatPlaceholder")}
              body={draft}
              mentions={draftMentions}
              members={props.serverMembers}
              onlineUsers={props.onlineUsers}
              t={props.t}
              onChange={(body, mentions) => {
                setDraft(body);
                setDraftMentions(mentions);
              }}
              onSubmit={() => composerRef.current?.form?.requestSubmit()}
              onEscape={() => setReplyTarget(null)}
            />
          </label>
          <button
            className="btn btn-primary composer-send"
            type="submit"
            aria-label={props.t("common.send")}
            title={props.t("common.send")}
          >
            <ArrowIcon />
            <span>{props.t("common.send")}</span>
          </button>
        </form>
        <p className="error-text" aria-live="polite">
          {error}
        </p>
      </footer>
      {showPins && roomId ? (
        <PinnedMessages
          roomId={roomId}
          revision={props.pinRevision}
          identityChanges={props.identityChanges}
          members={props.serverMembers}
          t={props.t}
          onClose={() => setShowPins(false)}
          onOpen={(messageId) => {
            setShowPins(false);
            jumpToMessage(messageId);
          }}
        />
      ) : null}
    </main>
  );
}
