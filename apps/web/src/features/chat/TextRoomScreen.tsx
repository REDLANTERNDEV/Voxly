import type { ChatMessage, ChatMessageReply } from "@voxly/shared";
import type { FormEvent } from "react";
import { useCallback,useLayoutEffect,useRef,useState } from "react";
import { serverPath } from "../../app/navigation.js";
import type { ShellActions,ShellModel } from "../../app/types.js";
import { ArrowIcon, CloseIcon, ReplyIcon } from "../../components/ui/Icons.js";
import { EmptyState,RoomHeader } from "../../components/ui/Primitives.js";
import { resolveRememberedRoom } from "../../lib/channelState.js";
import { isMessageListNearBottom,messageListUpdateAction,shouldSubmitComposer } from "../../lib/messages.js";
import { messageListIds,type OutboxEntry } from "../../lib/messageOutbox.js";
import { MessageItem } from "./MessageItem.js";
import { PendingMessageItem } from "./PendingMessageItem.js";
import { ReplyQuote } from "./ReplyQuote.js";
type TextRoomProps = Pick<ShellModel,
  "user" | "language" | "t" | "currentRoom" | "rooms" | "roomHistory" |
  "activeServerId"
> & Pick<ShellActions,
  "onNavigate"
> & {
  messages: ChatMessage[];
  outbox: OutboxEntry[];
  onSendMessage: (body: string, replyTo: ChatMessageReply | null) => void;
  onRetrySend: (localId: string) => void;
  onDiscardSend: (localId: string) => void;
  onUpdateMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onSuppressEmbed: (messageId: string, embedKey: string) => Promise<void>;
};

export function TextRoomScreen(props: TextRoomProps) {
  const [draft, setDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<ChatMessageReply | null>(null);
  const [error, setError] = useState("");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const listRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const previousMessageIdsRef = useRef<string[]>([]);
  const roomId = props.currentRoom?.id;
  const targetVoiceRoom = resolveRememberedRoom(
    props.rooms.voice,
    props.roomHistory[props.activeServerId]?.voice
  );

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  useLayoutEffect(() => {
    previousMessageIdsRef.current = messageListIds(props.messages.map((message) => message.id), props.outbox);
    wasNearBottomRef.current = true;
    setHasNewMessages(false);
    scrollToLatest("auto");
  }, [roomId, scrollToLatest]);

  useLayoutEffect(() => {
    const currentIds = messageListIds(props.messages.map((message) => message.id), props.outbox);
    const action = messageListUpdateAction(
      previousMessageIdsRef.current,
      currentIds,
      wasNearBottomRef.current
    );
    previousMessageIdsRef.current = currentIds;
    if (action === "scroll") scrollToLatest("auto");
    if (action === "notify") setHasNewMessages(true);
  }, [props.messages, props.outbox, scrollToLatest]);

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
    const body = draft.trim();
    if (!body) {
      setError(props.t("room.writeBeforeSending"));
      return;
    }

    setError("");
    setDraft("");
    props.onSendMessage(body, replyTarget);
    setReplyTarget(null);
  }

  function startReply(message: ChatMessage) {
    setReplyTarget({
      messageId: message.id,
      userId: message.userId,
      nickname: message.nickname,
      body: message.body
    });
    composerRef.current?.focus();
  }

  // Highlighting rather than only scrolling: in a dense room the jump alone
  // leaves the reader hunting for which line they were sent to.
  function jumpToMessage(messageId: string) {
    const target = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-jump-target");
    // Re-trigger the animation when the same message is jumped to twice.
    void target.offsetWidth;
    target.classList.add("is-jump-target");
  }

  return (
    <main className="main-panel" id="main-content">
        <RoomHeader
          title={`#${props.currentRoom?.name ?? "lobby"}`}
          subtitle={props.t("room.generalTalk")}
          actionLabel={targetVoiceRoom ? props.t("room.openChannel", { channel: targetVoiceRoom.name }) : undefined}
          onAction={targetVoiceRoom ? () => props.onNavigate(serverPath(props.activeServerId, "voice", targetVoiceRoom.id)) : undefined}
        />
        <div className="message-viewport">
          <section className="message-list" ref={listRef} aria-label={props.t("room.messages")} onScroll={handleListScroll}>
            <div className="message-day">{props.t("room.today")}</div>
            {props.messages.length === 0 && props.outbox.length === 0 ? (
              <EmptyState title={props.t("room.noMessages")} copy={props.t("room.noMessagesCopy")} />
            ) : (
              props.messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  user={props.user}
                  language={props.language}
                  t={props.t}
                  onUpdate={props.onUpdateMessage}
                  onDelete={props.onDeleteMessage}
                  onSuppressEmbed={props.onSuppressEmbed}
                  onReply={startReply}
                  onJumpToMessage={jumpToMessage}
                />
              ))
            )}
            {props.outbox.map((entry) => (
              <PendingMessageItem
                key={entry.localId}
                entry={entry}
                nickname={props.user.nickname}
                language={props.language}
                t={props.t}
                onRetry={props.onRetrySend}
                onDiscard={props.onDiscardSend}
              />
            ))}
          </section>
          {hasNewMessages ? (
            <button className="new-messages-indicator" type="button" onClick={() => scrollToLatest()}>
              {props.t("room.newMessages")}
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
        <footer className="composer">
          {replyTarget ? (
            <div className="composer-reply">
              <span className="composer-reply-label" aria-hidden="true"><ReplyIcon /></span>
              <span className="composer-reply-target">{props.t("room.replyingTo", { nickname: replyTarget.nickname })}</span>
              <ReplyQuote reply={replyTarget} t={props.t} hideAuthor />
              <button
                className="icon-btn"
                type="button"
                aria-label={props.t("room.replyCancel")}
                title={props.t("room.replyCancel")}
                onClick={() => { setReplyTarget(null); composerRef.current?.focus(); }}
              ><CloseIcon /></button>
            </div>
          ) : null}
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="messageInput">
              <span className="label composer-field-label">{props.t("room.messageLabel", { room: props.currentRoom?.name ?? "lobby" })}</span>
              <textarea
                ref={composerRef}
                className="textarea"
                id="messageInput"
                value={draft}
                name="message"
                placeholder={props.t("room.chatPlaceholder")}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && replyTarget) {
                    event.preventDefault();
                    setReplyTarget(null);
                    return;
                  }
                  if (!shouldSubmitComposer({
                    key: event.key,
                    shiftKey: event.shiftKey,
                    isComposing: event.nativeEvent.isComposing
                  })) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
            </label>
            <button className="btn btn-primary composer-send" type="submit" aria-label={props.t("common.send")} title={props.t("common.send")}>
              <ArrowIcon />
              <span>{props.t("common.send")}</span>
            </button>
          </form>
          <p className="error-text" aria-live="polite">{error}</p>
        </footer>
    </main>
  );
}
