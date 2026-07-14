import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";

const cardWidth = 184;
const cardHeight = 108;
const cardGap = 8;
const viewportMargin = 12;

export interface LiveStreamPopoverProps {
  icon: ReactNode;
  liveLabel: string;
  nickname: string;
  watchAriaLabel: string;
  watchLabel: string;
  onWatch(): void;
}

export function liveStreamCardPosition(
  trigger: { left: number; right: number; top: number; height: number },
  viewport: { width: number; height: number }
) {
  const preferredLeft = trigger.right + cardGap;
  const left = preferredLeft + cardWidth <= viewport.width - viewportMargin
    ? preferredLeft
    : Math.max(viewportMargin, trigger.left - cardWidth - cardGap);
  const centeredTop = trigger.top + trigger.height / 2 - cardHeight / 2;
  const top = Math.max(viewportMargin, Math.min(centeredTop, viewport.height - cardHeight - viewportMargin));
  return { left, top };
}

export function LiveStreamPopover(props: LiveStreamPopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const cardId = useId();

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openCard = useCallback(() => {
    cancelScheduledClose();
    const trigger = triggerRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPosition(liveStreamCardPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
    }
    setOpen(true);
  }, [cancelScheduledClose]);

  const closeCard = useCallback(() => {
    cancelScheduledClose();
    setOpen(false);
  }, [cancelScheduledClose]);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, 180);
  }, [cancelScheduledClose]);

  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeCard();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeCard, open]);

  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) closeCard();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeCard();
    triggerRef.current?.focus();
  };

  return (
    <span
      className={`voice-live-popover ${open ? "is-open" : ""}`}
      ref={rootRef}
      onBlur={onBlur}
      onFocus={openCard}
      onKeyDown={onKeyDown}
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <span className="voice-live-publisher">{props.nickname}</span>
      <button
        className="voice-live-trigger"
        type="button"
        ref={triggerRef}
        aria-controls={cardId}
        aria-expanded={open}
        onClick={openCard}
      >{props.liveLabel}</button>
      <span
        className="voice-live-card"
        id={cardId}
        role="group"
        aria-hidden={!open}
        style={{ left: position.left, top: position.top }}
        onMouseEnter={cancelScheduledClose}
        onMouseLeave={scheduleClose}
      >
        <button
          className="voice-live-preview"
          type="button"
          aria-label={props.watchAriaLabel}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            closeCard();
            props.onWatch();
          }}
        >
          <span className="voice-live-preview-icon" aria-hidden="true">{props.icon}</span>
          <span className="voice-live-preview-name">{props.nickname}</span>
          <span className="voice-live-preview-overlay">{props.watchLabel}</span>
        </button>
      </span>
    </span>
  );
}
