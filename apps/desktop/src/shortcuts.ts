import type { TranslationKey } from "./i18n.js";

export interface ShortcutSnapshot {
  preferences: {
    muteShortcut: string | null;
    deafenShortcut?: string | null;
    pushToTalkShortcut?: string | null;
    pushToMuteShortcut?: string | null;
    microphoneMode?: "openMic" | "pushToTalk" | "pushToMute";
  };
  registeredMuteShortcut: string | null;
  shortcutError: TranslationKey | null;
  registeredDeafenShortcut?: string | null;
  deafenShortcutError?: TranslationKey | null;
  registeredPushToTalkShortcut?: string | null;
  pushToTalkShortcutError?: TranslationKey | null;
  registeredPushToMuteShortcut?: string | null;
  pushToMuteShortcutError?: TranslationKey | null;
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
export function bindingFromKey(
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
export function bindingFromMouse(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  held?: ReadonlySet<string>
): string | null {
  if (![1, 3, 4].includes(event.button)) return null;
  return [...recordedModifiers(event, held), `Mouse${event.button === 1 ? 3 : event.button + 1}`].join("+");
}
export function bindingLabel(binding: string, mouseName = "Mouse"): string {
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

export function mountShortcutSettings({
  t,
  save,
  action = "mute"
}: {
  t: (key: TranslationKey) => string;
  save: (binding: string | null) => Promise<void>;
  action?: "mute" | "deafen" | "push-to-talk" | "push-to-mute";
}) {
  const input = document.getElementById(`${action}-shortcut`) as HTMLInputElement;
  const suffix = action === "mute" ? "shortcut" : `${action}-shortcut`;
  const record = document.getElementById(`record-${suffix}`) as HTMLButtonElement;
  const apply = document.getElementById(`save-${suffix}`) as HTMLButtonElement;
  const clear = document.getElementById(`clear-${suffix}`) as HTMLButtonElement;
  const status = document.getElementById(action === "mute" ? "shortcut-status" : `${action}-shortcut-status`)!;
  let snapshot: ShortcutSnapshot | null = null;
  let enabled = false;
  let recording = false;
  let draft: string | undefined;
  let message: TranslationKey | null = null;
  let suppressedMouseButton: number | null = null;
  let pendingModifier: string | null = null;
  const heldModifiers = new Set<string>();

  const refresh = () => {
    const fields = {
      mute: [snapshot?.preferences.muteShortcut, snapshot?.registeredMuteShortcut, snapshot?.shortcutError],
      deafen: [snapshot?.preferences.deafenShortcut, snapshot?.registeredDeafenShortcut, snapshot?.deafenShortcutError],
      "push-to-talk": [
        snapshot?.preferences.pushToTalkShortcut,
        snapshot?.registeredPushToTalkShortcut,
        snapshot?.pushToTalkShortcutError
      ],
      "push-to-mute": [
        snapshot?.preferences.pushToMuteShortcut,
        snapshot?.registeredPushToMuteShortcut,
        snapshot?.pushToMuteShortcutError
      ]
    } as const;
    const [savedBinding, registered, error] = fields[action];
    record.disabled = !enabled;
    record.textContent = t(recording ? "cancel" : "recordShortcut");
    apply.disabled = !enabled || recording || draft === undefined;
    clear.disabled = !enabled || recording || !savedBinding;
    const binding = draft ?? savedBinding;
    input.value = recording
      ? t("pressShortcut")
      : binding
        ? bindingLabel(binding, t("mouseButton"))
        : t("shortcutNone");
    status.textContent = t(message ?? error ?? (registered ? "shortcutRegistered" : "shortcutDisabled"));
  };
  const cancelRecording = () => {
    recording = false;
    pendingModifier = null;
    heldModifiers.clear();
    refresh();
  };
  record.addEventListener("click", () => {
    recording = !recording;
    pendingModifier = null;
    heldModifiers.clear();
    message = null;
    refresh();
    if (recording) input.focus();
  });
  input.addEventListener("keydown", (event) => {
    if (!recording) return;
    if (event.code === "Tab" || event.code === "Escape") {
      cancelRecording();
      if (event.code === "Escape") {
        event.preventDefault();
        record.focus();
      }
      return;
    }
    event.preventDefault();
    if (event.repeat) return;
    if (isShortcutModifier(event.code)) heldModifiers.add(event.code);
    const binding = bindingFromKey(event, heldModifiers);
    if (!binding) {
      pendingModifier = null;
      if (!/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) message = "shortcut_invalid";
      refresh();
      return;
    }
    if (isShortcutModifier(binding)) {
      pendingModifier = binding;
      return;
    }
    pendingModifier = null;
    draft = binding;
    message = "shortcutReady";
    recording = false;
    refresh();
    apply.focus();
  });
  input.addEventListener("keyup", (event) => {
    heldModifiers.delete(event.code);
    if (!recording || !pendingModifier) return;
    const released = isShortcutModifier(event.code) ? event.code : null;
    if (!released || released !== pendingModifier) return;
    event.preventDefault();
    pendingModifier = null;
    draft = released;
    message = "shortcutReady";
    recording = false;
    refresh();
    apply.focus();
  });
  window.addEventListener(
    "mousedown",
    (event) => {
      if (suppressedMouseButton === event.button) suppressedMouseButton = null;
      if (!recording) return;
      const binding = bindingFromMouse(event, heldModifiers);
      if (!binding) return;
      event.preventDefault();
      event.stopPropagation();
      suppressedMouseButton = event.button;
      draft = binding;
      message = "shortcutReady";
      recording = false;
      refresh();
      apply.focus();
    },
    true
  );
  for (const type of ["mouseup", "auxclick"]) {
    window.addEventListener(
      type,
      (event) => {
        const mouse = event as MouseEvent;
        if (mouse.button !== suppressedMouseButton) return;
        mouse.preventDefault();
        mouse.stopPropagation();
        if (type === "auxclick") suppressedMouseButton = null;
      },
      true
    );
  }
  input.addEventListener("blur", (event) => {
    if (event.relatedTarget !== record) cancelRecording();
  });
  window.addEventListener("blur", cancelRecording);
  const persist = async (binding: string | null) => {
    draft = undefined;
    message = null;
    await save(binding);
    refresh();
    record.focus();
  };
  apply.addEventListener("click", () => {
    if (draft !== undefined) void persist(draft);
  });
  clear.addEventListener("click", () => void persist(null));
  return {
    render(next: ShortcutSnapshot | null, available: boolean) {
      snapshot = next;
      enabled = available;
      if (!available) {
        recording = false;
        pendingModifier = null;
      }
      refresh();
    }
  };
}
