export type DesktopAction = "mute" | "deafen" | "pushToTalk" | "pushToMute";
export interface DesktopSettingsSnapshot {
  preferences: {
    installations: { id: string; origin: string; name?: string | null }[];
    defaultInstallationId: string | null;
    openOnStartup: boolean;
    muteShortcut: string | null;
    deafenShortcut: string | null;
    pushToTalkShortcut: string | null;
    pushToMuteShortcut: string | null;
    microphoneMode: "openMic" | "pushToTalk" | "pushToMute";
    pushToTalkReleaseDelayMs: number;
  };
  registeredMuteShortcut: string | null;
  registeredDeafenShortcut: string | null;
  registeredPushToTalkShortcut: string | null;
  registeredPushToMuteShortcut: string | null;
  shortcutError: string | null;
  deafenShortcutError: string | null;
  pushToTalkShortcutError: string | null;
  pushToMuteShortcutError: string | null;
}
export type DesktopSettingsOperation =
  | { kind: "read" | "ready" | "home" | "authenticationCompleted" }
  | { kind: "default"; id: string | null; enabled: boolean }
  | { kind: "resetShortcut"; action: DesktopAction }
  | { kind: "shortcut"; action: DesktopAction; binding: string | null }
  | { kind: "microphone"; mode: DesktopSettingsSnapshot["preferences"]["microphoneMode"] }
  | { kind: "delay"; milliseconds: number }
  | { kind: "recording"; enabled: boolean };
export interface DesktopSettingsBridge {
  version: 1;
  apply(operation: DesktopSettingsOperation): Promise<DesktopSettingsSnapshot>;
}
export function desktopSettingsAvailable(target: { __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge }): boolean {
  return target.__VOXLY_DESKTOP_SETTINGS_V1__?.version === 1 && typeof target.__VOXLY_DESKTOP_SETTINGS_V1__.apply === "function";
}
export async function applyDesktopSettings(operation: DesktopSettingsOperation): Promise<DesktopSettingsSnapshot> {
  if (!desktopSettingsAvailable(window)) throw new Error("unavailable");
  return window.__VOXLY_DESKTOP_SETTINGS_V1__!.apply(operation);
}
export function desktopKeyboardBinding(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">): string | null {
  if (event.repeat || !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(event.code)) return null;
  if (!/^F/.test(event.code) && !(event.ctrlKey || event.altKey || event.metaKey)) return null;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", event.code].filter(Boolean).join("+");
}
export function desktopMouseBinding(event: Pick<MouseEvent, "button" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (![1, 3, 4].includes(event.button)) return null;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", `Mouse${event.button === 1 ? 3 : event.button + 1}`].filter(Boolean).join("+");
}
export function desktopBindingLabel(value: string): string {
  return value.replace(/Control/g, "Ctrl").replace(/Super/g, "Win").replace(/Key|Digit/g, "").split("+").join(" + ");
}
declare global { interface Window { __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge } }

/** Only a completed browser approval can update the local startup preference. */
export async function rememberCompletedDesktopAuthentication(
  target: { __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge },
  outcome: string, current: () => boolean,
): Promise<void> {
  if (outcome !== "approved" || !current() || !desktopSettingsAvailable(target)) return;
  try { await target.__VOXLY_DESKTOP_SETTINGS_V1__!.apply({ kind: "authenticationCompleted" }); }
  catch { /* Local storage failure must not undo a successful sign-in. */ }
}
