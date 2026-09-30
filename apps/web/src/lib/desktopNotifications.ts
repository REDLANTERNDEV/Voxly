import { readLanguageChoice, translate, type LanguageCode, type TranslationKey } from "./i18n.js";
import { notificationSoundAllowed, type NotificationSoundPreferences } from "./notificationSounds.js";
import type { NotificationSoundKey } from "./notificationSounds.js";
import type { DesktopVoiceBridge } from "./desktopVoice.js";
import type { StorageLike } from "./voiceVolume.js";

export type DesktopNotificationKind = "message" | "voicePeerJoin" | "voicePeerLeave" | "screenShareStart" | "screenShareStop" | "connectionLost" | "connectionRestored";
export type DesktopNotificationPermission = NotificationPermission | "unavailable";

interface NotificationHandle {
  close(): void;
  onclick: ((event: Event) => void) | null;
  onclose: ((event: Event) => void) | null;
}
export interface DesktopNotificationTarget { roomId: string; kind: "text" | "voice" }
export function desktopNotificationPath(target: DesktopNotificationTarget, roomServerIds: Record<string, string>, servers: readonly { id: string }[]): string | null {
  const serverId = Object.hasOwn(roomServerIds, target.roomId) ? roomServerIds[target.roomId] : undefined;
  if (!serverId || !servers.some((server) => server.id === serverId)) return null;
  return `/app/server/${encodeURIComponent(serverId)}/${target.kind}/${encodeURIComponent(target.roomId)}`;
}
interface ActivationBridge { version: 1; show(): Promise<boolean> }
declare global {
  interface Window { __VOXLY_DESKTOP_ACTIVATION_V1__?: ActivationBridge }
}
export interface SystemNotificationApi {
  new(title: string, options: NotificationOptions): NotificationHandle;
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  prototype: { silent?: boolean | null };
}
export interface DesktopNotificationRuntime {
  __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge;
  __VOXLY_DESKTOP_ACTIVATION_V1__?: ActivationBridge;
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

/** Content and routes remain web-local; native activation only shows the current window. */
export function createDesktopNotificationDelivery(runtime: DesktopNotificationRuntime, now = Date.now) {
  const last = new Map<string, number>();
  const handles = new Map<string, NotificationHandle>();
  let disposed = false;
  const retire = (handle: NotificationHandle) => {
    handle.onclick = null;
    handle.onclose = null;
    try { handle.close(); } catch { /* Closing an expired OS alert is optional. */ }
  };
  const send = (kind: DesktopNotificationKind, context: {
    userId: string; enabled: boolean; focused: boolean; deafened: boolean;
    preferences: NotificationSoundPreferences; language?: LanguageCode;
    target?: DesktopNotificationTarget;
    isCurrent?: () => boolean;
    activate?: (target: DesktopNotificationTarget) => void;
  }): boolean => {
    if (disposed) return false;
    if (!context.enabled || context.focused || desktopNotificationPermission(runtime) !== "granted") return false;
    if (!notificationSoundAllowed(kind, context.preferences, { deafened: context.deafened })) return false;
    const key = `${context.userId}:${kind}`;
    const time = now();
    if (time - (last.get(key) ?? -Infinity) < 1_000) return false;
    try {
      const handle = new runtime.Notification!("Voxly", {
        body: translate(context.language ?? readLanguageChoice(), labels[kind]),
        tag: `voxly:${kind}`, silent: true
      });
      const previous = handles.get(key);
      if (previous) retire(previous);
      handles.set(key, handle);
      // Snapshot the channel, but check the live Account again after native focus.
      const target = context.target ? { ...context.target } : undefined;
      handle.onclose = () => {
        if (handles.get(key) === handle) handles.delete(key);
        handle.onclick = null;
        handle.onclose = null;
      };
      handle.onclick = () => {
        if (disposed || handles.get(key) !== handle || !context.isCurrent?.()) return;
        handles.delete(key);
        retire(handle);
        const bridge = runtime.__VOXLY_DESKTOP_ACTIVATION_V1__;
        if (bridge?.version !== 1 || typeof bridge.show !== "function") return;
        void (async () => {
          try {
            if (await bridge.show() && !disposed && context.isCurrent?.() && target) context.activate?.(target);
          } catch { /* Activation failure must not navigate or interrupt a call. */ }
        })();
      };
      last.set(key, time);
      return true;
    } catch { return false; }
  };
  send.dispose = () => {
    disposed = true;
    for (const handle of handles.values()) retire(handle);
    handles.clear();
    last.clear();
  };
  return send;
}
