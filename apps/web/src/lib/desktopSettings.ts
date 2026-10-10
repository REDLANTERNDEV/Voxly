export type DesktopAction = "mute" | "deafen" | "pushToTalk" | "pushToMute";
export interface DesktopSettingsSnapshot {
  preferences: {
    installations: { id: string; origin: string; name?: string | null }[];
    defaultInstallationId: string | null;
    openOnStartup: boolean;
    quitOnClose?: boolean;
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
  | { kind: "quitOnClose"; enabled: boolean }
  | { kind: "recording"; enabled: boolean };
export interface DesktopSettingsBridge {
  version: 1;
  apply(operation: DesktopSettingsOperation): Promise<DesktopSettingsSnapshot>;
}
export function desktopSettingsAvailable(target: { __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge }): boolean {
  return (
    target.__VOXLY_DESKTOP_SETTINGS_V1__?.version === 1 &&
    typeof target.__VOXLY_DESKTOP_SETTINGS_V1__.apply === "function"
  );
}
export async function applyDesktopSettings(operation: DesktopSettingsOperation): Promise<DesktopSettingsSnapshot> {
  if (!desktopSettingsAvailable(window)) throw new Error("unavailable");
  return window.__VOXLY_DESKTOP_SETTINGS_V1__!.apply(operation);
}
const modifierGroups = [
  ["Control", "ControlLeft", "ControlRight", "ctrlKey"],
  ["Alt", "AltLeft", "AltRight", "altKey"],
  ["Shift", "ShiftLeft", "ShiftRight", "shiftKey"],
  ["Super", "MetaLeft", "MetaRight", "metaKey"]
] as const;
export function isShortcutModifier(code: string): boolean {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code);
}
function recordedModifiers(
  event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  held?: ReadonlySet<string>
): string[] {
  return modifierGroups.flatMap(([generic, left, right, flag]) => {
    if (!event[flag]) return [];
    const sides = held ? [left, right].filter((code) => held.has(code)) : [];
    return sides.length ? sides : [generic];
  });
}
export function desktopKeyboardBinding(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">,
  held?: ReadonlySet<string>
): string | null {
  if (event.repeat) return null;
  if (isShortcutModifier(event.code)) return event.code;
  if (
    !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|Semicolon|Quote|Comma|Period|Slash|Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter))$/.test(
      event.code
    )
  )
    return null;
  return [...recordedModifiers(event, held), event.code].join("+");
}
export function desktopMouseBinding(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  held?: ReadonlySet<string>
): string | null {
  if (![1, 3, 4].includes(event.button)) return null;
  return [...recordedModifiers(event, held), `Mouse${event.button === 1 ? 3 : event.button + 1}`].join("+");
}
export function desktopBindingLabel(binding: string, mouseName = "Mouse"): string {
  const names: Record<string, string> = {
    Control: "Ctrl",
    ControlLeft: "LCtrl",
    ControlRight: "RCtrl",
    AltLeft: "LAlt",
    AltRight: "RAlt",
    ShiftLeft: "LShift",
    ShiftRight: "RShift",
    Super: "Win",
    MetaLeft: "LWin",
    MetaRight: "RWin",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    IntlBackslash: "Intl \\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/"
  };
  return binding
    .split("+")
    .map(
      (part) =>
        names[part] ??
        part
          .replace(/^(Key|Digit)/, "")
          .replace(/^Mouse([345])$/, `${mouseName} $1`)
          .replace(/^Numpad/, "Numpad ")
    )
    .join(" + ");
}

declare global {
  interface Window {
    __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge;
  }
}

/** Only a completed browser approval can update the local startup preference. */
export async function rememberCompletedDesktopAuthentication(
  target: { __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge },
  outcome: string,
  current: () => boolean
): Promise<void> {
  if (outcome !== "approved" || !current() || !desktopSettingsAvailable(target)) return;
  try {
    await target.__VOXLY_DESKTOP_SETTINGS_V1__!.apply({ kind: "authenticationCompleted" });
  } catch {
    /* Local storage failure must not undo a successful sign-in. */
  }
}

declare global {
  interface Window {
    __VOXLY_DESKTOP_MEDIA_PERMISSIONS_V1__?: {
      version: 1;
      resetMicrophone(): Promise<boolean>;
      resetCamera(): Promise<boolean>;
    };
  }
}
