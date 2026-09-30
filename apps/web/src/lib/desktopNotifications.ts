import { readLanguageChoice, translate, type LanguageCode, type TranslationKey } from "./i18n.js";
import { notificationSoundAllowed, type NotificationSoundPreferences } from "./notificationSounds.js";
import type { NotificationSoundKey } from "./notificationSounds.js";
import type { DesktopVoiceBridge } from "./desktopVoice.js";
import type { StorageLike } from "./voiceVolume.js";

export type DesktopNotificationKind = "message" | "voicePeerJoin" | "voicePeerLeave" | "screenShareStart" | "screenShareStop" | "connectionLost" | "connectionRestored";
export type DesktopNotificationPermission = NotificationPermission | "unavailable";

interface NotificationHandle { close(): void }
export interface SystemNotificationApi {
  new(title: string, options: NotificationOptions): NotificationHandle;
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  prototype: { silent?: boolean | null };
}
export interface DesktopNotificationRuntime {
  __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge;
  Notification?: SystemNotificationApi;
}

const labels: Record<DesktopNotificationKind, TranslationKey> = {
  message: "desktopNotifications.message",
  voicePeerJoin: "desktopNotifications.peerJoined",
  voicePeerLeave: "desktopNotifications.peerLeft",
  screenShareStart: "desktopNotifications.screenStarted",
  screenShareStop: "desktopNotifications.screenStopped",
  connectionLost: "desktopNotifications.connectionLost",
  connectionRestored: "desktopNotifications.connectionRestored"
};
export function isDesktopNotificationKind(key: NotificationSoundKey): key is DesktopNotificationKind {
  return Object.hasOwn(labels, key);
}

function storageKey(userId: string) { return `voxly:desktop-notifications:v1:${userId}`; }
function browserStorage(): StorageLike | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; }
  catch { return undefined; }
}
export function readDesktopNotifications(userId: string, storage = browserStorage()): boolean {
  try { return storage?.getItem(storageKey(userId)) === "true"; }
  catch { return false; }
}
export function writeDesktopNotifications(userId: string, enabled: boolean, storage = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(storageKey(userId), String(enabled));
    return true;
  } catch { return false; }
}

export function desktopNotificationPermission(runtime: DesktopNotificationRuntime): DesktopNotificationPermission {
  // Require silent delivery: Voxly's existing cue player owns all sound.
  const api = runtime.Notification;
  return runtime.__VOXLY_DESKTOP_V1__?.version === 1 && api && "silent" in api.prototype
    ? api.permission : "unavailable";
}
export async function requestDesktopNotificationPermission(runtime: DesktopNotificationRuntime): Promise<DesktopNotificationPermission> {
  const current = desktopNotificationPermission(runtime);
  if (current !== "default") return current;
  try { return await runtime.Notification!.requestPermission(); }
  catch { return "unavailable"; }
}

/** Runtime notifications use browser permission, with no remote-to-native IPC. */
export function createDesktopNotificationDelivery(runtime: DesktopNotificationRuntime, now = Date.now) {
  const last = new Map<string, number>();
  return (kind: DesktopNotificationKind, context: {
    userId: string; enabled: boolean; focused: boolean; deafened: boolean;
    preferences: NotificationSoundPreferences; language?: LanguageCode;
  }): boolean => {
    if (!context.enabled || context.focused || desktopNotificationPermission(runtime) !== "granted") return false;
    if (!notificationSoundAllowed(kind, context.preferences, { deafened: context.deafened })) return false;
    const key = `${context.userId}:${kind}`;
    const time = now();
    if (time - (last.get(key) ?? -Infinity) < 1_000) return false;
    try {
      new runtime.Notification!("Voxly", {
        body: translate(context.language ?? readLanguageChoice(), labels[kind]),
        tag: `voxly:${kind}`, silent: true
      });
      last.set(key, time);
      return true;
    } catch { return false; }
  };
}
