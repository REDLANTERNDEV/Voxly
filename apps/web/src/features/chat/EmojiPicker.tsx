import {
  chatEmojiCatalog,
  chatEmojiGroups,
  maxMessageReactionKinds,
  type ChatEmojiEntry,
  type ChatEmojiGroup,
  type MessageReaction
} from "@voxly/shared";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Translate } from "../../app/types.js";
import { moveInGrid } from "../../lib/emojiGrid.js";
import { rememberEmoji, useRecentEmoji } from "../../lib/recentReactions.js";
import { ChatDialog } from "./ChatDialog.js";

type SectionId = "recent" | ChatEmojiGroup;
interface Section {
  id: SectionId;
  entries: readonly ChatEmojiEntry[];
}

const byEmoji = new Map(chatEmojiCatalog.map((entry) => [entry[0], entry]));
const groupGlyph = Object.fromEntries(
  chatEmojiGroups.map((group) => [group, chatEmojiCatalog.find((entry) => entry[1] === group)?.[0] ?? ""])
) as Record<ChatEmojiGroup, string>;

/**
 * The emoji picker for the composer and for reactions alike.
 *
 * Like Discord's: a search box and a row of group tabs stay on top, and below
 * them one scrolling list of groups, each under its own heading, starting with
 * what this Device used last. The tabs jump to a group and follow the scroll.
 * Typing a search folds the groups into one list of matches in either language.
 */
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
  const [active, setActive] = useState<SectionId>("recent");
  const [focusIndex, setFocusIndex] = useState(0);
  const [preview, setPreview] = useState<ChatEmojiEntry | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Searching is the quickest way through a thousand glyphs, so typing starts there.
  const searchRef = useRef<HTMLInputElement | null>(null);
  const recent = useRecentEmoji();
  const full = Boolean(reactions && reactions.length >= maxMessageReactionKinds);
  const normalized = query.trim().toLocaleLowerCase();

  const sections = useMemo<Section[]>(() => {
    if (normalized) {
      return [
        {
          id: "recent",
          entries: chatEmojiCatalog.filter(([emoji, , en, tr]) =>
            `${emoji} ${en} ${tr}`.toLocaleLowerCase().includes(normalized)
          )
        }
      ];
    }
    // Not flatMap: an entry is itself an array and would be spread into glyphs.
    const recentEntries = recent
      .map((emoji) => byEmoji.get(emoji))
      .filter((entry): entry is ChatEmojiEntry => entry !== undefined);
    return [
      ...(recentEntries.length ? [{ id: "recent" as const, entries: recentEntries }] : []),
      ...chatEmojiGroups.map((group) => ({
        id: group,
        entries: chatEmojiCatalog.filter((entry) => entry[1] === group)
      }))
    ];
  }, [normalized, recent]);
  const flat = sections.flatMap((section) => section.entries);
  const tabs: SectionId[] = [...(recent.length ? (["recent"] as const) : []), ...chatEmojiGroups];

  function sectionLabel(id: SectionId) {
    return t(id === "recent" ? "chat.emoji.recent" : `chat.emoji.${id}`);
  }

  function jumpTo(id: SectionId) {
    const container = scrollRef.current;
    // Measured from the section, not its heading: a sticky heading reports
    // where it is stuck, not where its group starts.
    const section = container?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!container || !section) return;
    container.scrollTo({ top: section.offsetTop });
    setActive(id);
  }

  function followScroll() {
    const container = scrollRef.current;
    if (!container || normalized) return;
    let current: SectionId = sections[0]?.id ?? "recent";
    for (const section of Array.from(container.querySelectorAll<HTMLElement>("[data-section]"))) {
      if (section.offsetTop <= container.scrollTop + 4) current = section.dataset.section as SectionId;
    }
    setActive(current);
  }

  function choose(emoji: string) {
    rememberEmoji(emoji);
    onSelect(emoji);
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".emoji-grid button"));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const grid = (document.activeElement as HTMLElement).closest<HTMLElement>(".emoji-grid");
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 8;
    const next = moveInGrid(current, event.key, columns, buttons.length);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    buttons[next]?.focus();
    buttons[next]?.scrollIntoView({ block: "nearest" });
  }

  let position = 0;
  return (
    <ChatDialog title={t("chat.emojiPicker")} onClose={onClose} t={t} initialFocus={searchRef}>
      <div className="emoji-picker">
        <div className="emoji-picker-top">
          <input
            ref={searchRef}
            className="input"
            aria-label={t("chat.emojiSearch")}
            placeholder={t("chat.emojiSearch")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFocusIndex(0);
              scrollRef.current?.scrollTo({ top: 0 });
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              scrollRef.current?.querySelector<HTMLButtonElement>(".emoji-grid button")?.focus();
            }}
          />
          {normalized ? null : (
            <div className="emoji-categories" role="group" aria-label={t("chat.emojiCategories")}>
              {tabs.map((id) => (
                <button
                  type="button"
                  key={id}
                  aria-label={sectionLabel(id)}
                  title={sectionLabel(id)}
                  aria-current={active === id ? "true" : undefined}
                  onClick={() => jumpTo(id)}
                >
                  <span aria-hidden="true">{id === "recent" ? "🕘" : groupGlyph[id]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {full ? (
          <p className="chat-help" role="status">
            {t("chat.reactionLimit")}
          </p>
        ) : null}
        <div className="emoji-scroll" ref={scrollRef} onScroll={followScroll} onKeyDown={moveFocus}>
          {sections.map((section) => (
            <section
              key={section.id}
              data-section={section.id}
              aria-label={normalized ? t("chat.emojiSearch") : sectionLabel(section.id)}
            >
              {normalized ? null : <h3 className="emoji-section-heading">{sectionLabel(section.id)}</h3>}
              <div className="emoji-grid">
                {section.entries.map((entry) => {
                  const [emoji, , en, tr] = entry;
                  const index = position++;
                  return (
                    <button
                      type="button"
                      key={`${section.id}-${emoji}`}
                      tabIndex={index === Math.min(focusIndex, flat.length - 1) ? 0 : -1}
                      disabled={full && !reactions?.some((reaction) => reaction.emoji === emoji)}
                      aria-label={`${emoji} ${en} / ${tr}`}
                      title={`${en} / ${tr}`}
                      onMouseEnter={() => setPreview(entry)}
                      onFocus={() => {
                        setPreview(entry);
                        setFocusIndex(index);
                      }}
                      onClick={() => choose(emoji)}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {!flat.length ? <p className="emoji-empty">{t("chat.noResults")}</p> : null}
        </div>
        <footer className="emoji-preview" aria-hidden="true">
          {preview ? (
            <>
              <span className="emoji-preview-glyph">{preview[0]}</span>
              <span>{t("chat.emojiPreview", { en: preview[2], tr: preview[3] })}</span>
            </>
          ) : (
            <span>{t("chat.emojiPreviewHint")}</span>
          )}
        </footer>
      </div>
    </ChatDialog>
  );
}
