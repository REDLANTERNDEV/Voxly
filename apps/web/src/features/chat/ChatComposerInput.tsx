import type { MessageMention, PresenceUser } from "@voxly/shared";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import type { Translate } from "../../app/types.js";
import { shouldSubmitComposer } from "../../lib/messages.js";
import { editMentionRanges, mentionCandidates, rebaseMentionSelection } from "../../lib/chatInteractions.js";
import { EmojiIcon } from "../../components/ui/Icons.js";
import { EmojiPicker } from "./EmojiPicker.js";

export function ChatComposerInput({
  body,
  mentions,
  onChange,
  members,
  onlineUsers,
  t,
  inputRef,
  onSubmit,
  onEscape,
  label,
  id,
  placeholder,
  trailingControl
}: {
  body: string;
  mentions: MessageMention[];
  onChange(body: string, mentions: MessageMention[]): void;
  members: PresenceUser[];
  onlineUsers: PresenceUser[];
  t: Translate;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSubmit(): void;
  onEscape?(): void;
  label: string;
  id?: string;
  placeholder?: string;
  trailingControl?: ReactNode;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const fieldRef = inputRef ?? localRef;
  const listId = useId();
  const [caret, setCaret] = useState(body.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [picker, setPicker] = useState(false);
  const [composing, setComposing] = useState(false);
  const selection = useRef({ start: body.length, end: body.length });
  const pendingEdit = useRef<{ start: number; end: number; inputType: string } | null>(null);
  const previousContent = useRef({ body, mentions });
  const insertedMention = useRef<MessageMention | null>(null);
  // The browser's undo history restores text but knows nothing of Mentions, so
  // recent texts remember theirs and Ctrl+Z brings a real Mention back.
  const recentContent = useRef(new Map<string, MessageMention[]>());
  const match = /(?:^|\s)@([^\s@]*)$/.exec(body.slice(0, caret));
  const query = match?.[1] ?? "";
  const start = match ? caret - query.length - 1 : -1;
  const onlineIds = new Set(onlineUsers.map((member) => member.userId));
  const candidates = mentionCandidates(members, onlineIds, query);
  const options: Array<{ key: string; text: string; member?: PresenceUser; kind: "person" | "everyone" | "here" }> = [
    ...["everyone", "here"]
      .filter((kind) => kind.includes(query.toLocaleLowerCase()))
      .map((kind) => ({ key: kind, text: `@${kind}`, kind: kind as "everyone" | "here" })),
    ...candidates.map((member) => ({
      key: member.userId,
      text: `@${member.nickname} · #${member.mentionCode}`,
      member,
      kind: "person" as const
    }))
  ];
  const showSuggestions =
    start >= 0 &&
    !composing &&
    !dismissed &&
    options.length > 0 &&
    !mentions.some((mention) => start >= mention.start && start < mention.end);

  useEffect(() => {
    if (showSuggestions)
      document
        .getElementById(`${listId}-${Math.min(active, options.length - 1)}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, showSuggestions, listId, options.length]);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const beforeInput = (event: InputEvent) => {
      pendingEdit.current = { start: field.selectionStart, end: field.selectionEnd, inputType: event.inputType };
    };
    field.addEventListener("beforeinput", beforeInput);
    return () => field.removeEventListener("beforeinput", beforeInput);
  }, [fieldRef]);

  useLayoutEffect(() => {
    const previous = previousContent.current;
    const identityChanged = previous.mentions.some((mention, index) => {
      const next = mentions[index];
      return (
        next?.id === mention.id &&
        (next.nickname !== mention.nickname ||
          next.authorDeleted !== mention.authorDeleted ||
          next.mentionCode !== mention.mentionCode)
      );
    });
    if (identityChanged && previous.body !== body) {
      const next = rebaseMentionSelection(previous.mentions, mentions, selection.current);
      selection.current = next;
      setCaret(next.start);
      const field = fieldRef.current;
      field?.setSelectionRange(next.start, next.end, field.selectionDirection ?? undefined);
    }
    previousContent.current = { body, mentions };
    const recent = recentContent.current;
    recent.delete(body);
    recent.set(body, mentions);
    if (recent.size > 100) recent.delete(recent.keys().next().value!);
  }, [body, mentions, fieldRef]);

  // Through the browser's own editing, so Ctrl+Z still reaches what was typed
  // before; handing React a new value would wipe the field's undo history.
  // The resulting input event runs onChange like any keystroke.
  function insertText(from: number, to: number, text: string) {
    const field = fieldRef.current;
    if (!field) return false;
    field.focus();
    field.setSelectionRange(from, to);
    return document.execCommand("insertText", false, text);
  }
  function placeCaret(position: number) {
    setCaret(position);
    selection.current = { start: position, end: position };
    requestAnimationFrame(() => {
      fieldRef.current?.focus();
      fieldRef.current?.setSelectionRange(position, position);
    });
  }
  function selectMention(index: number) {
    const option = options[index];
    if (!option) return;
    const text = option.member ? `@${option.member.nickname}` : option.text;
    const next = body.slice(0, start) + text + " " + body.slice(caret);
    const ranges = editMentionRanges(body, next, mentions, { start, end: caret });
    const base = {
      id: crypto.randomUUID(),
      start,
      end: start + text.length,
      nickname: option.member?.nickname ?? "",
      mentionCode: option.member?.mentionCode ?? "",
      authorDeleted: false,
      recipientIds: option.member ? [option.member.userId] : []
    };
    const mention: MessageMention =
      option.kind === "person"
        ? { ...base, kind: "person", userId: option.member!.userId }
        : { ...base, kind: option.kind };
    insertedMention.current = mention;
    if (!insertText(start, caret, text + " ")) {
      insertedMention.current = null;
      onChange(
        next,
        [...ranges, mention].sort((a, b) => a.start - b.start)
      );
    }
    setDismissed(true);
    placeCaret(start + text.length + 1);
  }
  return (
    <div className="chat-composer-input">
      <textarea
        ref={fieldRef}
        className="textarea"
        id={id}
        name="message"
        aria-label={label}
        placeholder={placeholder}
        value={body}
        rows={1}
        aria-autocomplete="list"
        aria-controls={showSuggestions ? listId : undefined}
        aria-expanded={showSuggestions}
        aria-activedescendant={showSuggestions ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
        onSelect={(event) => {
          const field = event.currentTarget;
          selection.current = { start: field.selectionStart, end: field.selectionEnd };
          setCaret(field.selectionStart);
        }}
        onChange={(event) => {
          const field = event.target;
          const edit = pendingEdit.current;
          pendingEdit.current = null;
          if (edit && edit.start === edit.end && field.value.length < body.length) {
            const removed = body.length - field.value.length;
            if (/Backward$/u.test(edit.inputType)) edit.start -= removed;
            else if (/Forward$/u.test(edit.inputType)) edit.end += removed;
            else {
              edit.start = field.selectionStart;
              edit.end = edit.start + removed;
            }
          }
          const ranges = editMentionRanges(body, field.value, mentions, edit ?? undefined);
          const inserted = insertedMention.current;
          insertedMention.current = null;
          const undoing = (event.nativeEvent as InputEvent).inputType?.startsWith("history");
          const restored = undoing ? recentContent.current.get(field.value) : undefined;
          onChange(
            field.value,
            restored ?? (inserted ? [...ranges, inserted].sort((a, b) => a.start - b.start) : ranges)
          );
          setCaret(event.target.selectionStart);
          selection.current = { start: event.target.selectionStart, end: event.target.selectionEnd };
          setActive(0);
          setDismissed(false);
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (showSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            return;
          }
          if (showSuggestions && event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            selectMention(Math.min(active, options.length - 1));
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            if (showSuggestions) setDismissed(true);
            else onEscape?.();
            return;
          }
          if (
            shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing
            })
          ) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {trailingControl}
      {showSuggestions ? (
        <div className="mention-suggestions" id={listId} role="listbox" aria-label={t("chat.mentionPeople")}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`${listId}-${index}`}
              key={option.key}
              aria-selected={Math.min(active, options.length - 1) === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectMention(index)}
            >
              <span>{option.text}</span>
              <small>
                {option.member
                  ? `${t(option.member.role === "owner" ? "chat.owner" : "chat.member")} · ${t(onlineIds.has(option.member.userId) ? "chat.online" : "chat.offline")}`
                  : t(option.kind === "everyone" ? "chat.everyoneHelp" : "chat.hereHelp")}
              </small>
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="chat-emoji-trigger icon-btn"
        aria-label={t("chat.addEmoji")}
        title={t("chat.addEmoji")}
        onClick={() => {
          const field = fieldRef.current;
          if (field) selection.current = { start: field.selectionStart, end: field.selectionEnd };
          setPicker(true);
        }}
      >
        <EmojiIcon />
      </button>
      {picker ? (
        <EmojiPicker
          t={t}
          onClose={() => setPicker(false)}
          onSelect={(emoji) => {
            const { start: from, end: to } = selection.current;
            const next = body.slice(0, from) + emoji + body.slice(to);
            if (!insertText(from, to, emoji))
              onChange(next, editMentionRanges(body, next, mentions, { start: from, end: to }));
            setPicker(false);
            setDismissed(true);
            placeCaret(from + emoji.length);
          }}
        />
      ) : null}
    </div>
  );
}
