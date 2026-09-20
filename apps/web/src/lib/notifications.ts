import type { TranslationKey } from "./i18n.js";

export type NotificationTone = "danger" | "warning" | "success" | "neutral";
export type NotificationAction = "open-audio-settings";

export interface AppNotificationInput {
  id: string;
  tone: NotificationTone;
  titleKey: TranslationKey;
  messageKey: TranslationKey;
  timeoutMs: number | null;
  action?: NotificationAction;
}

export interface AppNotification extends AppNotificationInput {
  occurrences: number;
  revision: number;
}

export type NotificationEvent =
  | { type: "push"; notification: AppNotificationInput }
  | { type: "dismiss"; id: string; revision?: number }
  | { type: "expire"; id: string; revision: number }
  | { type: "clear" };

/**
 * The notification lifecycle without React, timers, or presentation.
 *
 * An id names one recoverable condition. Pushing the same id again records a
 * new occurrence rather than stacking duplicate cards. The revision lets a
 * timer from an earlier occurrence prove that it is stale before removing the
 * current one.
 */
export function notificationReducer(state: AppNotification[], event: NotificationEvent): AppNotification[] {
  if (event.type === "clear") return [];
  if (event.type === "dismiss") {
    return state.filter((item) => item.id !== event.id || (event.revision !== undefined && item.revision !== event.revision));
  }
  if (event.type === "expire") {
    return state.filter((item) => item.id !== event.id || item.revision !== event.revision);
  }

  const existing = state.find((item) => item.id === event.notification.id);
  const next: AppNotification = existing
    ? {
        ...event.notification,
        occurrences: existing.occurrences + 1,
        revision: existing.revision + 1
      }
    : {
        ...event.notification,
        occurrences: 1,
        revision: 1
      };

  return [next, ...state.filter((item) => item.id !== event.notification.id)];
}
