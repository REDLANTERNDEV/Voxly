import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errorKey, translate, type Language, type TranslationKey } from "./i18n.js";
import { createCaptureOwner, probeConstraints, screenConstraints, summarizeTracks, transitionWithMediaCleanup, type ProbeKind } from "./media.js";
import "./styles.css";
import { mountShortcutSettings, type ShortcutSnapshot } from "./shortcuts.js";

interface Installation { id: string; origin: string }
interface Snapshot extends ShortcutSnapshot {
  preferences: { installations: Installation[]; language: Language; trayAcknowledged: boolean; muteShortcut: string | null };
  active: Installation | null;
  platform: string;
  shellVersion: string;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const native = isTauri();
let language: Language = navigator.language.startsWith("tr") ? "tr" : "en";
let state: Snapshot | null = null;
let busy = false;
let confirmPending = false;
const captures = createCaptureOwner();
let toneContext: AudioContext | null = null;
let toneGeneration = 0;
const probeResults: { kind: ProbeKind; outcome: "captured" | "failed"; error?: string; audioTracks?: number; videoTracks?: number }[] = [];

function t(key: TranslationKey) { return translate(language, key); }
function status(key: TranslationKey) { element("status").textContent = t(key); }
function probeStatus(key: TranslationKey) { element("probe-status").textContent = t(key); }

const shortcutSettings = mountShortcutSettings({ t, save: async (binding) => {
  await run(async () => {
    try { state = await invoke<Snapshot>("set_mute_shortcut", { binding }); }
    finally { state = await invoke<Snapshot>("shell_state"); }
  });
} });

function renderTranslations() {
  document.documentElement.lang = language;
  document.title = t("title");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n as TranslationKey);
  });
  element<HTMLSelectElement>("language").value = language;
  element("installation-list").setAttribute("aria-label", t("installations"));
  element("preview").setAttribute("aria-label", t("previewLabel"));
  element<HTMLSelectElement>("output").options[0].textContent = t("defaultOutput");
}

function renderInstallations() {
  const list = element("installation-list");
  const focused = document.activeElement as HTMLElement | null;
  const focusKey = focused && list.contains(focused) ? focused.dataset.focusKey : null;
  list.replaceChildren();
  for (const saved of state?.preferences.installations ?? []) {
    const row = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = saved.origin;
    row.append(name);
    const actions = document.createElement("div");
    actions.className = "actions";
    const add = (key: TranslationKey, action: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t(key);
      button.dataset.focusKey = `${saved.id}:${key}`;
      button.disabled = busy;
      button.addEventListener("click", action);
      actions.append(button);
    };
    add("connect", () => void connect(saved));
    add("browser", () => void run(async () => { await invoke("open_installation_browser", { id: saved.id }); }));
    add("forget", () => void run(async () => {
      state = await invoke<Snapshot>("forget_installation", { id: saved.id });
      status("forgotten");
    }));
    row.append(actions);
    list.append(row);
  }
  if (focusKey) {
    const next = [...list.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.dataset.focusKey === focusKey);
    (next ?? element("address")).focus();
  }
  element("empty").hidden = Boolean(state?.preferences.installations.length);
  element("connection").textContent = state?.active ? `${t("connected")}: ${state.active.origin}` : t("disconnected");
  element<HTMLButtonElement>("disconnect").disabled = !state?.active || busy;
  element<HTMLButtonElement>("retry").disabled = !state?.active || busy;
  element<HTMLButtonElement>("save").disabled = !native || busy || !state;
  element<HTMLButtonElement>("quit").disabled = !native || busy || !state;
  element<HTMLSelectElement>("language").disabled = native && (!state || busy);
  shortcutSettings.render(state, native && state?.platform === "windows" && !busy);
}

async function confirmAction(quitting = false): Promise<boolean> {
  if (confirmPending) return false;
  confirmPending = true;
  const dialog = element<HTMLDialogElement>("confirm-dialog");
  const opener = document.activeElement as HTMLElement | null;
  element("confirm-body").textContent = t(quitting ? "quitConfirmationBody" : "confirmationBody");
  element("confirm-title").textContent = t(quitting ? "quit" : "confirmationTitle");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => {
    confirmPending = false;
    opener?.focus();
    resolve(dialog.returnValue === "confirm");
  }, { once: true }));
}

async function run(action: () => Promise<void>) {
  if (!native || busy || !state) return;
  busy = true;
  renderInstallations();
  try { await action(); } catch (error: unknown) { status(errorKey(error)); }
  finally { busy = false; renderInstallations(); }
}

async function connect(saved: Installation, reload = false) {
  if (busy) return;
  const changing = state?.active && (state.active.id !== saved.id || reload);
  if (changing && !await confirmAction()) return;
  await run(async () => {
    status("checking");
    const open = () => invoke<Snapshot>("connect_installation", { id: saved.id, confirmLeave: Boolean(changing), reload });
    state = changing || !state?.active ? await transitionWithMediaCleanup(stopMedia, open) : await open();
    element("status").textContent = "";
  });
}

element("installation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const address = element<HTMLInputElement>("address");
    state = await invoke<Snapshot>("save_installation", { address: address.value });
    address.value = "";
    status("saved");
  });
});
element("language").addEventListener("change", (event) => {
  const selected = (event.target as HTMLSelectElement).value as Language;
  if (!native) { language = selected; renderTranslations(); renderInstallations(); return; }
  void run(async () => {
    state = await invoke<Snapshot>("set_language", { language: selected });
    language = state.preferences.language;
    renderTranslations();
  });
});
element("disconnect").addEventListener("click", () => {
  void (async () => {
    if (busy || !await confirmAction()) return;
    await run(async () => { state = await transitionWithMediaCleanup(stopMedia, () => invoke<Snapshot>("disconnect_installation", { confirmLeave: true })); });
  })();
});
element("retry").addEventListener("click", () => { if (state?.active) void connect(state.active, true); });

async function quit() {
  if (busy || !await confirmAction(true)) return;
  await run(async () => {
    stopMedia();
    await invoke("quit_app", { confirmLeave: true });
  });
}
element("quit").addEventListener("click", () => void quit());

function refreshReport() {
  const media = navigator.mediaDevices;
  const context = typeof AudioContext === "undefined" ? null : AudioContext.prototype as AudioContext & { setSinkId?: unknown };
  element<HTMLTextAreaElement>("report").value = JSON.stringify({
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    shellVersion: state?.shellVersion ?? null,
    platform: state?.platform ?? "browser-preview",
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    api: {
      getUserMedia: typeof media?.getUserMedia === "function",
      getDisplayMedia: typeof media?.getDisplayMedia === "function",
      restrictOwnAudio: (media?.getSupportedConstraints?.() as MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean } | undefined)?.restrictOwnAudio === true,
      enumerateDevices: typeof media?.enumerateDevices === "function",
      audioContextSink: typeof context?.setSinkId === "function",
      mediaElementSink: typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function",
      audioWorklet: Boolean(context && "audioWorklet" in context),
      webRTC: typeof RTCPeerConnection === "function"
    },
    liveTracks: captures.current() ? summarizeTracks(captures.current()!) : [],
    probes: probeResults.slice(-20)
  }, null, 2);
}

function stopMedia() {
  captures.stop();
  const video = element<HTMLVideoElement>("preview");
  video.srcObject = null;
  video.hidden = true;
  toneGeneration += 1;
  if (toneContext) void toneContext.close().catch(() => undefined);
  toneContext = null;
}

async function probe(kind: ProbeKind) {
  const ticket = captures.begin();
  const video = element<HTMLVideoElement>("preview");
  video.srcObject = null;
  video.hidden = true;
  try {
    // Invoke immediately in the click handler to retain display-capture activation.
    const stream = kind === "screen"
      ? await navigator.mediaDevices.getDisplayMedia(screenConstraints)
      : await navigator.mediaDevices.getUserMedia(probeConstraints(kind));
    if (!captures.accept(ticket, stream)) return;
    video.srcObject = stream;
    video.hidden = stream.getVideoTracks().length === 0;
    stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
      if (!captures.isCurrent(ticket)) return;
      stopMedia();
      probeStatus("captureStopped");
      refreshReport();
    }, { once: true }));
    probeResults.push({ kind, outcome: "captured", audioTracks: stream.getAudioTracks().length, videoTracks: stream.getVideoTracks().length });
    probeStatus(kind === "screen" && !stream.getAudioTracks().length ? "screenNoAudio" : "probeStarted");
  } catch (error: unknown) {
    if (!captures.isCurrent(ticket)) return;
    probeResults.push({ kind, outcome: "failed", error: error instanceof DOMException ? error.name : "Error" });
    probeStatus("probeFailed");
  }
  refreshReport();
}

for (const kind of ["microphone", "camera", "screen"] as const) {
  element(kind).addEventListener("click", () => void probe(kind));
}
element("stop").addEventListener("click", () => { stopMedia(); probeStatus("captureStopped"); refreshReport(); });

element("devices").addEventListener("click", () => {
  void (async () => {
    try {
      const output = element<HTMLSelectElement>("output");
      const selected = output.value;
      const devices = await navigator.mediaDevices.enumerateDevices();
      output.replaceChildren(new Option(t("defaultOutput"), ""));
      devices.filter((device) => device.kind === "audiooutput").forEach((device, index) => {
        output.add(new Option(device.label || `${t("deviceFallback")} ${index + 1}`, device.deviceId));
      });
      output.value = [...output.options].some((option) => option.value === selected) ? selected : "";
    } catch { probeStatus("devicesFailed"); }
  })();
});

element("tone").addEventListener("click", () => {
  void (async () => {
    const generation = ++toneGeneration;
    if (toneContext) void toneContext.close().catch(() => undefined);
    let context: (AudioContext & { setSinkId?(id: string): Promise<void> }) | null = null;
    try {
      context = new AudioContext();
      toneContext = context;
      const output = element<HTMLSelectElement>("output").value;
      if (output) {
        if (!context.setSinkId) { probeStatus("noSink"); await context.close(); return; }
        await context.setSinkId(output);
      }
      await context.resume();
      if (generation !== toneGeneration) { await context.close(); return; }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = .06;
      oscillator.frequency.value = 660;
      oscillator.connect(gain).connect(context.destination);
      oscillator.addEventListener("ended", () => {
        void context!.close().catch(() => undefined);
        if (toneContext === context) toneContext = null;
      }, { once: true });
      oscillator.start();
      oscillator.stop(context.currentTime + .4);
      probeStatus("soundPlayed");
    } catch {
      if (context) void context.close().catch(() => undefined);
      if (generation === toneGeneration) probeStatus("toneFailed");
    }
  })();
});

element("refresh-report").addEventListener("click", refreshReport);
element("copy-report").addEventListener("click", () => {
  void navigator.clipboard.writeText(element<HTMLTextAreaElement>("report").value)
    .then(() => probeStatus("copied"))
    .catch(() => { element<HTMLTextAreaElement>("report").select(); probeStatus("copyFailed"); });
});
window.addEventListener("pagehide", stopMedia);

async function start() {
  renderTranslations();
  renderInstallations();
  refreshReport();
  element("browser-preview").hidden = native;
  if (!native) return;
  try {
    state = await invoke<Snapshot>("shell_state");
    language = state.preferences.language;
    renderTranslations();
    renderInstallations();
    refreshReport();
    await listen("shell:quit-requested", () => void quit());
    if (!state.preferences.trayAcknowledged) {
      const dialog = element<HTMLDialogElement>("tray-dialog");
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "confirm") void run(async () => { state = await invoke<Snapshot>("acknowledge_tray"); });
      });
      dialog.showModal();
    }
  } catch (error: unknown) { status(errorKey(error)); }
}
void start();
