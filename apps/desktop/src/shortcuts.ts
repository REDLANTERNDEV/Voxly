import type { TranslationKey } from "./i18n.js";

export interface ShortcutSnapshot {
  preferences: { muteShortcut: string | null; deafenShortcut?: string | null; pushToTalkShortcut?: string | null; pushToMuteShortcut?: string | null; microphoneMode?: "openMic" | "pushToTalk" | "pushToMute" };
  registeredMuteShortcut: string | null;
  shortcutError: TranslationKey | null;
  registeredDeafenShortcut?: string | null;
  deafenShortcutError?: TranslationKey | null;
  registeredPushToTalkShortcut?: string | null;
  pushToTalkShortcutError?: TranslationKey | null;
  registeredPushToMuteShortcut?: string | null;
  pushToMuteShortcutError?: TranslationKey | null;
}

export function bindingFromKey(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">): string | null {
  if (event.repeat || !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(event.code)) return null;
  if (!/^F/.test(event.code) && !(event.ctrlKey || event.altKey || event.metaKey)) return null;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", event.code].filter(Boolean).join("+");
}

export function bindingFromMouse(event: Pick<MouseEvent, "button" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (![1, 3, 4].includes(event.button)) return null;
  const button = event.button === 1 ? 3 : event.button + 1;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", `Mouse${button}`].filter(Boolean).join("+");
}

export function bindingLabel(binding: string, mouseName = "Mouse"): string {
  return binding.split("+").map((part) => part === "Control" ? "Ctrl" : part === "Super" ? "Win" : part.replace(/^(Key|Digit)/, "").replace(/^Mouse([345])$/, `${mouseName} $1`)).join(" + ");
}

export function mountShortcutSettings({ t, save, action = "mute" }: {
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

  const refresh = () => {
    const fields = {
      mute: [snapshot?.preferences.muteShortcut, snapshot?.registeredMuteShortcut, snapshot?.shortcutError],
      deafen: [snapshot?.preferences.deafenShortcut, snapshot?.registeredDeafenShortcut, snapshot?.deafenShortcutError],
      "push-to-talk": [snapshot?.preferences.pushToTalkShortcut, snapshot?.registeredPushToTalkShortcut, snapshot?.pushToTalkShortcutError],
      "push-to-mute": [snapshot?.preferences.pushToMuteShortcut, snapshot?.registeredPushToMuteShortcut, snapshot?.pushToMuteShortcutError]
    } as const;
    const [savedBinding, registered, error] = fields[action];
    record.disabled = !enabled;
    record.textContent = t(recording ? "cancel" : "recordShortcut");
    apply.disabled = !enabled || recording || draft === undefined;
    clear.disabled = !enabled || recording || !savedBinding;
    const binding = draft ?? savedBinding;
    input.value = recording ? t("pressShortcut") : binding ? bindingLabel(binding, t("mouseButton")) : t("shortcutNone");
    status.textContent = t(message ?? error ?? (registered ? "shortcutRegistered" : "shortcutDisabled"));
  };
  const cancelRecording = () => { recording = false; refresh(); };
  record.addEventListener("click", () => {
    recording = !recording;
    message = null;
    refresh();
    if (recording) input.focus();
  });
  input.addEventListener("keydown", (event) => {
    if (!recording) return;
    if (event.code === "Tab" || event.code === "Escape") {
      cancelRecording();
      if (event.code === "Escape") { event.preventDefault(); record.focus(); }
      return;
    }
    event.preventDefault();
    const binding = bindingFromKey(event);
    if (!binding) {
      if (!/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) message = "shortcut_invalid";
      refresh();
      return;
    }
    draft = binding;
    message = "shortcutReady";
    recording = false;
    refresh();
    apply.focus();
  });
  window.addEventListener("mousedown", (event) => {
    if (suppressedMouseButton === event.button) suppressedMouseButton = null;
    if (!recording) return;
    const binding = bindingFromMouse(event);
    if (!binding) return;
    event.preventDefault();
    event.stopPropagation();
    suppressedMouseButton = event.button;
    draft = binding;
    message = "shortcutReady";
    recording = false;
    refresh();
    apply.focus();
  }, true);
  for (const type of ["mouseup", "auxclick"]) {
    window.addEventListener(type, (event) => {
      const mouse = event as MouseEvent;
      if (mouse.button !== suppressedMouseButton) return;
      mouse.preventDefault();
      mouse.stopPropagation();
      if (type === "auxclick") suppressedMouseButton = null;
    }, true);
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
  apply.addEventListener("click", () => { if (draft !== undefined) void persist(draft); });
  clear.addEventListener("click", () => void persist(null));
  return {
    render(next: ShortcutSnapshot | null, available: boolean) {
      snapshot = next;
      enabled = available;
      if (!available) recording = false;
      refresh();
    }
  };
}
