import { useCallback,useEffect,useReducer,useRef,useState,type CSSProperties } from "react";
import type { Translate } from "../../app/types.js";
import {
  notificationReducer,
  type AppNotification,
  type AppNotificationInput,
  type NotificationTone
} from "../../lib/notifications.js";
import { CloseIcon } from "./Icons.js";

function NotificationMark({ tone }: { tone: NotificationTone }) {
  if (tone === "success") {
    return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.25 4.25L19 7" /></svg>;
  }
  if (tone === "warning") {
    return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 4.2 2.5 18a2 2 0 0 0 1.75 3h15.5a2 2 0 0 0 1.75-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4.5" /><path d="M12 17.4h.01" /></svg>;
  }
  if (tone === "danger") {
    return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v5.3" /><path d="M12 16.7h.01" /></svg>;
  }
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 10.5v6" /><path d="M12 7.2h.01" /></svg>;
}

export function useNotificationCenter() {
  const [notifications, dispatch] = useReducer(notificationReducer, []);
  const push = useCallback((notification: AppNotificationInput) => dispatch({ type: "push", notification }), []);
  const dismiss = useCallback((id: string, revision?: number) => dispatch({ type: "dismiss", id, revision }), []);
  const expire = useCallback((id: string, revision: number) => dispatch({ type: "expire", id, revision }), []);
  const clear = useCallback(() => dispatch({ type: "clear" }), []);
  return { notifications, push, dismiss, expire, clear };
}

function NotificationCard({ item, suspended, t, onDismiss, onExpire, onAction }: {
  item: AppNotification;
  suspended: boolean;
  t: Translate;
  onDismiss: (id: string, revision?: number) => void;
  onExpire: (id: string, revision: number) => void;
  onAction?: (item: AppNotification) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const remainingRef = useRef(item.timeoutMs ?? 0);
  const startedAtRef = useRef(0);
  const revisionRef = useRef(item.revision);

  const stopTimer = useCallback(() => {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAtRef.current));
  }, []);

  const finish = useCallback((kind: "dismiss" | "expire") => {
    stopTimer();
    setLeaving(true);
    window.setTimeout(() => {
      if (kind === "expire") onExpire(item.id, item.revision);
      else onDismiss(item.id, item.revision);
    }, 180);
  }, [item.id, item.revision, onDismiss, onExpire, stopTimer]);

  const startTimer = useCallback(() => {
    if (item.timeoutMs === null || suspended || leaving || timeoutRef.current !== null) return;
    startedAtRef.current = performance.now();
    timeoutRef.current = window.setTimeout(() => finish("expire"), remainingRef.current);
  }, [finish, item.timeoutMs, leaving, suspended]);

  useEffect(() => {
    if (revisionRef.current !== item.revision) {
      revisionRef.current = item.revision;
      remainingRef.current = item.timeoutMs ?? 0;
      setLeaving(false);
      cardRef.current?.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(0)" }],
        { duration: 190, easing: "ease-out" }
      );
    }
    if (suspended) {
      stopTimer();
      return;
    }
    startTimer();
    return stopTimer;
  }, [item.revision, item.timeoutMs, startTimer, stopTimer, suspended]);

  return (
    <article
      ref={cardRef}
      className={`notification-card notification-${item.tone} ${leaving ? "is-leaving" : ""}`}
      role={item.tone === "danger" ? "alert" : "status"}
      onMouseEnter={stopTimer}
      onMouseLeave={startTimer}
      onFocusCapture={stopTimer}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) startTimer();
      }}
    >
      <span className="notification-mark"><NotificationMark tone={item.tone} /></span>
      <span className="notification-copy">
        <span className="notification-title-row">
          <strong>{t(item.titleKey)}</strong>
          {item.occurrences > 1 ? (
            <span key={item.revision} className="notification-count" aria-label={t("notification.occurrences", { count: item.occurrences })}>×{item.occurrences}</span>
          ) : null}
        </span>
        <span className="notification-message">{t(item.messageKey)}</span>
        {item.action && onAction ? (
          <button className="notification-action" type="button" onClick={() => { onAction(item); finish("dismiss"); }}>
            {t("settings.audio")}
          </button>
        ) : null}
      </span>
      <button className="notification-close" type="button" aria-label={t("notification.dismiss")} onClick={() => finish("dismiss")}>
        <CloseIcon />
      </button>
      {item.timeoutMs === null ? null : <span key={item.revision} className="notification-timer" style={{ "--notification-duration": `${item.timeoutMs}ms` } as CSSProperties} />}
    </article>
  );
}

export function NotificationViewport({ items, suspended = false, t, onDismiss, onExpire, onAction }: {
  items: AppNotification[];
  suspended?: boolean;
  t: Translate;
  onDismiss: (id: string, revision?: number) => void;
  onExpire: (id: string, revision: number) => void;
  onAction?: (item: AppNotification) => void;
}) {
  return (
    <section className={`notification-region ${suspended ? "is-suspended" : ""}`} aria-label={t("notification.region")}>
      {items.map((item) => <NotificationCard key={item.id} item={item} suspended={suspended} t={t} onDismiss={onDismiss} onExpire={onExpire} onAction={onAction} />)}
    </section>
  );
}

export function InlineAlert({ title, message, dismissLabel, actionLabel, onAction, onDismiss }: {
  title: string;
  message: string;
  dismissLabel: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="inline-alert" role="alert">
      <span className="inline-alert-mark"><NotificationMark tone="danger" /></span>
      <span className="inline-alert-copy"><strong>{title}</strong><span>{message}</span></span>
      <span className="inline-alert-actions">
        {actionLabel && onAction ? <button className="inline-alert-action" type="button" onClick={onAction}>{actionLabel}</button> : null}
        <button className="inline-alert-close" type="button" aria-label={dismissLabel} onClick={onDismiss}><CloseIcon /></button>
      </span>
    </div>
  );
}
