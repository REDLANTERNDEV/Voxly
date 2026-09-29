import type { TranslationKey } from "./i18n.js";

export interface ShortcutSnapshot {
  preferences: { muteShortcut: string | null };
  registeredMuteShortcut: string | null;
  shortcutError: TranslationKey | null;
}

export function bindingFromKey(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat">): string | null {
  if (event.repeat || !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4]))$/.test(event.code)) return null;
  if (!/^F/.test(event.code) && !(event.ctrlKey || event.altKey || event.metaKey)) return null;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", event.code].filter(Boolean).join("+");
}

export function bindingLabel(binding: string): string {
  return binding.split("+").map((part) => part === "Control" ? "Ctrl" : part === "Super" ? "Win" : part.replace(/^(Key|Digit)/, "")).join(" + ");
}

export function mountShortcutSettings({ t, save }: {
  t: (key: TranslationKey) => string;
  save: (binding: string | null) => Promise<void>;
}) {
  const input = document.getElementById("mute-shortcut") as HTMLInputElement;
  const record = document.getElementById("record-shortcut") as HTMLButtonElement;
  const apply = document.getElementById("save-shortcut") as HTMLButtonElement;
  const clear = document.getElementById("clear-shortcut") as HTMLButtonElement;
  const status = document.getElementById("shortcut-status")!;
  let snapshot: ShortcutSnapshot | null = null;
  let enabled = false;
  let recording = false;
  let draft: string | undefined;
  let message: TranslationKey | null = null;

  const refresh = () => {
    record.disabled = !enabled;
    record.textContent = t(recording ? "cancel" : "recordShortcut");
    apply.disabled = !enabled || recording || draft === undefined;
    clear.disabled = !enabled || recording || !snapshot?.preferences.muteShortcut;
    const binding = draft ?? snapshot?.preferences.muteShortcut;
    input.value = recording ? t("pressShortcut") : binding ? bindingLabel(binding) : t("shortcutNone");
    status.textContent = t(message ?? snapshot?.shortcutError ?? (snapshot?.registeredMuteShortcut ? "shortcutRegistered" : "shortcutDisabled"));
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
