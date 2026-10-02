/// <reference types="vite/client" />
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errorKey, translate, type Language, type TranslationKey } from "./i18n.js";
import { createCaptureOwner, probeConstraints, screenConstraints, summarizeTracks, type ProbeKind } from "./media.js";
import { performTransition, type CallState } from "./transitions.js";
import "./styles.css";
import "./home.css";
import { startupInstallation } from "./home.js";
import { installVerifiedUpdate, type UpdateSnapshot } from "./updates.js";
import { mountShortcutSettings, type ShortcutSnapshot } from "./shortcuts.js";

interface Installation { id: string; origin: string; name?: string | null }
interface DesktopLink extends Installation { launchId: string | null }
interface Snapshot extends ShortcutSnapshot {
  preferences: { installations: Installation[]; defaultInstallationId: string | null; openOnStartup: boolean; display: { fullAddresses: boolean; compactList: boolean; installationIcons: boolean }; language: Language; trayAcknowledged: boolean; muteShortcut: string | null; deafenShortcut: string | null; pushToTalkShortcut: string | null; pushToMuteShortcut: string | null; microphoneMode: "openMic" | "pushToTalk" | "pushToMute"; pushToTalkReleaseDelayMs: number };
  active: Installation | null;
  loading: boolean;
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
let pendingDesktopLink: DesktopLink | null = null;
let deferredDesktopLink: DesktopLink | null = null;
let busy = false;
let pendingQuit = false;
let loadingTarget: Installation | null = null;
let receivedReady: Snapshot | null = null;
let connectionRevision = 0;
let booting = true;
let failedConnection: Installation | null = null;
let attemptedConnection: Installation | null = null;
let renaming: Installation | null = null;
let updateState: UpdateSnapshot | null = null;
let updateWorking = false;
let confirmPending = false;
const captures = createCaptureOwner();
let toneContext: AudioContext | null = null;
let toneGeneration = 0;
const probeResults: { kind: ProbeKind; outcome: "captured" | "failed"; error?: string; audioTracks?: number; videoTracks?: number }[] = [];

function t(key: TranslationKey) { return translate(language, key); }
function status(key: TranslationKey) { element("status").textContent = t(key); }
function renderLoading() {
  const loading = booting || Boolean(loadingTarget);
  document.body.classList.toggle("is-loading", loading);
  element("loading-status").textContent = t(loadingTarget ? "openingInstallation" : "openingVoxly");
  element("loading-origin").textContent = loadingTarget?.origin ?? "";
  element<HTMLButtonElement>("cancel-connection").hidden = !loadingTarget;
}
async function openConnection(saved: Installation, arguments_: Record<string, unknown>): Promise<Snapshot | undefined> {
  const revision = ++connectionRevision;
  loadingTarget = saved; receivedReady = null; booting = false; renderLoading();
  try {
    const next = await invoke<Snapshot>("connect_installation", arguments_);
    if (revision !== connectionRevision) return undefined;
    const ready = receivedReady as Snapshot | null;
    const result = ready?.active?.id === next.active?.id ? ready! : next;
    if (!result.loading) loadingTarget = null;
    renderLoading();
    return result;
  } catch (error) {
    if (revision !== connectionRevision) return undefined;
    loadingTarget = null; renderLoading(); throw error;
  }
}
async function cancelLoading() {
  connectionRevision += 1; loadingTarget = null; receivedReady = null; attemptedConnection = null; booting = false; renderLoading();
  state = await invoke<Snapshot>("cancel_connection"); renderInstallations(); element("address").focus();
}
element("cancel-connection").addEventListener("click", () => { void cancelLoading().catch((error) => status(errorKey(error))); });
function probeStatus(key: TranslationKey) { element("probe-status").textContent = t(key); }

const shortcutSettings = ([
  ["mute", "set_mute_shortcut"], ["deafen", "set_deafen_shortcut"],
  ["push-to-talk", "set_push_to_talk_shortcut"], ["push-to-mute", "set_push_to_mute_shortcut"]
] as const).map(([action, command]) => mountShortcutSettings({ t, action, save: async (binding) => {
  await run(async () => {
    try { state = await invoke<Snapshot>(command, { binding }); }
    finally { state = await invoke<Snapshot>("shell_state"); }
  });
} }));

element<HTMLSelectElement>("microphone-mode").addEventListener("change", () => {
  const mode = element<HTMLSelectElement>("microphone-mode").value;
  void run(async () => { state = await invoke<Snapshot>("set_microphone_mode", { mode }); });
});
const releaseDelay = element<HTMLInputElement>("push-to-talk-release-delay");
const releaseDelayEnabled = element<HTMLInputElement>("push-to-talk-delay-enabled");
releaseDelay.addEventListener("input", () => {
  element("push-to-talk-delay-value").textContent = `${releaseDelay.value} ms`;
  releaseDelay.setAttribute("aria-valuetext", `${releaseDelay.value} ms`);
});
function saveReleaseDelay(delayMs: number) {
  void run(async () => { state = await invoke<Snapshot>("set_push_to_talk_release_delay", { delayMs }); });
}
releaseDelay.addEventListener("change", () => saveReleaseDelay(Number(releaseDelay.value)));
releaseDelayEnabled.addEventListener("change", () => saveReleaseDelay(releaseDelayEnabled.checked ? 200 : 0));

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

function renderUpdates() {
  const phase = updateState?.phase ?? "disabled";
  const keys = { disabled: "updateDisabled", idle: "updateIdle", checking: "updateChecking", current: "updateCurrent", available: "updateAvailable", downloading: "updateDownloading", ready: "updateReady", installing: "updateInstalling", error: "update_unavailable" } as const;
  const messages = [`Voxly v${state?.shellVersion ?? updateState?.currentVersion ?? "—"}`, t(keys[phase])];
  if (updateState?.version && ["available", "ready", "downloading"].includes(phase)) messages.push(updateState.version);
  if (phase === "downloading") messages.push(`${Math.round((updateState?.downloaded ?? 0) / 1024)} KB`);
  if (updateState?.error) messages.push(t(errorKey(updateState.error)));
  element("update-status").textContent = messages.join(" ");
  element<HTMLButtonElement>("update-check").disabled = !native || !state || phase === "disabled" || busy || updateWorking || phase === "ready";
  element<HTMLButtonElement>("update-download").hidden = phase !== "available";
  element<HTMLButtonElement>("update-download").disabled = busy || updateWorking;
  element<HTMLButtonElement>("update-install").hidden = phase !== "ready";
  element<HTMLButtonElement>("update-install").disabled = busy || updateWorking;
  element<HTMLButtonElement>("update-cancel").hidden = phase !== "downloading" && phase !== "ready";
  element<HTMLButtonElement>("update-cancel").disabled = busy;
}

async function updateOperation(command: "check_shell_update" | "download_shell_update") {
  if (!native || !state || busy || updateWorking) return;
  updateWorking = true;
  renderUpdates();
  let polling = false;
  const progress = command === "download_shell_update" ? window.setInterval(() => {
    if (polling) return;
    polling = true;
    void invoke<UpdateSnapshot>("shell_update_state").then((next) => {
      if (updateWorking) { updateState = next; renderUpdates(); }
    }).catch(() => undefined).finally(() => { polling = false; });
  }, 1000) : undefined;
  try {
    updateState = { currentVersion: state.shellVersion, phase: command === "check_shell_update" ? "checking" : "downloading", version: updateState?.version ?? null, downloaded: 0, total: null, error: null };
    renderUpdates();
    updateState = await invoke<UpdateSnapshot>(command);
  } catch (error) { status(errorKey(error)); }
  finally {
    if (progress !== undefined) window.clearInterval(progress);
    updateWorking = false;
    renderUpdates();
  }
}

element("update-check").addEventListener("click", () => void updateOperation("check_shell_update"));
element("update-download").addEventListener("click", () => void updateOperation("download_shell_update"));
element("update-cancel").addEventListener("click", () => {
  void invoke<UpdateSnapshot>("cancel_shell_update").then((next) => { updateState = next; renderUpdates(); }).catch((error) => status(errorKey(error)));
});
element("update-install").addEventListener("click", () => {
  if (updateState?.phase !== "ready" || updateWorking) return;
  void run(async () => {
    try {
      await installVerifiedUpdate({ report: () => invoke<CallState | null>("transition_state"),
        confirm: (report) => confirmAction(false, report, true), stop: stopMedia,
        install: async () => { await invoke("install_shell_update", { confirmed: true }); }
      });
    } finally {
      state = await invoke<Snapshot>("shell_state");
      updateState = await invoke<UpdateSnapshot>("shell_update_state");
    }
  });
});

function renderInstallations() {
  renderUpdates();
  renderLoading();
  element("desktop-link").hidden = !pendingDesktopLink;
  element("desktop-link-origin").textContent = pendingDesktopLink?.origin ?? "";
  element<HTMLButtonElement>("desktop-link-review").disabled = busy;
  element<HTMLButtonElement>("desktop-link-dismiss").disabled = busy;
  const list = element("installation-list");
  const focused = document.activeElement as HTMLElement | null;
  const focusKey = focused && list.contains(focused) ? focused.dataset.focusKey : null;
  list.replaceChildren();
  for (const saved of state?.preferences.installations ?? []) {
    const row = document.createElement("li");
    row.className = "saved-installation";
    if (state?.preferences.display.installationIcons) {
      const icon = document.createElement("img"); icon.src = "/voxly-icon.png"; icon.alt = ""; icon.className = "installation-icon"; row.append(icon);
    }
    const identity = document.createElement("div"); identity.className = "installation-identity";
    const name = document.createElement("strong");
    name.textContent = saved.name || new URL(saved.origin).host;
    const address = document.createElement("span");
    address.textContent = state?.preferences.display.fullAddresses ? saved.origin : new URL(saved.origin).host;
    address.title = saved.origin;
    identity.append(name, address); row.append(identity);
    if (saved.id === state?.preferences.defaultInstallationId) {
      const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = t("defaultBadge"); row.append(badge);
    }
    const actions = document.createElement("div"); actions.className = "actions";
    const add = (key: TranslationKey, action: () => void, parent: HTMLElement = actions) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = t(key);
      button.setAttribute("aria-label", `${t(key)}: ${name.textContent}`);
      button.dataset.focusKey = `${saved.id}:${key}`; button.disabled = busy;
      button.addEventListener("click", action); parent.append(button);
    };
    add("launchDefault", () => void connect(saved));
    const menu = document.createElement("details"); menu.className = "installation-menu";
    const trigger = document.createElement("summary"); trigger.textContent = "•••"; trigger.setAttribute("aria-label", `${t("moreActions")}: ${name.textContent}`); trigger.dataset.focusKey = `${saved.id}:menu`;
    const menuItems = document.createElement("div"); menuItems.className = "installation-menu-items";
    add("rename", () => {
      menu.open = false; renaming = saved; element<HTMLInputElement>("rename-name").value = saved.name ?? "";
      element("rename-status").textContent = ""; element<HTMLDialogElement>("rename-dialog").showModal(); element("rename-name").focus();
    }, menuItems);
    add("makeDefault", () => void run(async () => {
      state = await invoke<Snapshot>("desktop_settings", { operation: { kind: "default", id: saved.id, enabled: state?.preferences.openOnStartup ?? false } });
    }), menuItems);
    add("forget", () => void run(async () => { state = await invoke<Snapshot>("forget_installation", { id: saved.id }); status("forgotten"); }), menuItems);
    menu.append(trigger, menuItems); actions.append(menu);
    row.append(actions);
    list.append(row);
  }
  if (focusKey) {
    const next = [...list.querySelectorAll<HTMLElement>("[data-focus-key]")].find((button) => button.dataset.focusKey === focusKey);
    (next ?? element("address")).focus();
  }
  const preferred = state?.preferences.installations.find((entry) => entry.id === state?.preferences.defaultInstallationId);
  element("default-panel").hidden = !preferred && !state?.preferences.installations.length;
  element("saved-panel").hidden = !state?.preferences.installations.length;
  element("connection").hidden = !state?.active;
  element("default-name").textContent = preferred?.name || (preferred ? new URL(preferred.origin).host : t("noDefault"));
  element("default-origin").textContent = preferred?.origin ?? "";
  element<HTMLButtonElement>("launch-default").disabled = !preferred || busy;
  element("launch-default").setAttribute("aria-label", `${t("launchDefault")}: ${preferred?.name || preferred?.origin || t("noDefault")}`);
  element<HTMLInputElement>("open-startup").checked = state?.preferences.openOnStartup ?? false;
  element<HTMLInputElement>("open-startup").disabled = !preferred || busy;
  list.classList.toggle("compact", state?.preferences.display.compactList ?? false);
  for (const [id, key] of [["full-addresses", "fullAddresses"], ["compact-list", "compactList"], ["installation-icons", "installationIcons"]] as const) {
    element<HTMLInputElement>(id).checked = state?.preferences.display[key] ?? key !== "compactList";
    element<HTMLInputElement>(id).disabled = !native || !state || busy;
  }
  element("connection-recovery").hidden = !failedConnection;
  element("empty").hidden = Boolean(state?.preferences.installations.length);
  element("connection").textContent = state?.active ? `${t("connected")}: ${state.active.origin}` : t("disconnected");
  element("disconnect").hidden = !state?.active;
  element("retry").hidden = !state?.active;
  element<HTMLButtonElement>("disconnect").disabled = !state?.active || busy;
  element<HTMLButtonElement>("retry").disabled = !state?.active || busy;
  element<HTMLButtonElement>("save").disabled = !native || busy || !state;
  element<HTMLSelectElement>("language").disabled = native && (!state || busy);
  for (const id of ["microphone", "camera", "screen", "tone"]) element<HTMLButtonElement>(id).disabled = busy;
  const shortcutsAvailable = native && state?.platform === "windows" && !busy;
  for (const settings of shortcutSettings) settings.render(state, shortcutsAvailable);
  element<HTMLSelectElement>("microphone-mode").disabled = !shortcutsAvailable;
  element<HTMLSelectElement>("microphone-mode").value = state?.preferences.microphoneMode ?? "openMic";
  const delayMs = state?.preferences.pushToTalkReleaseDelayMs ?? 0;
  const delayAvailable = shortcutsAvailable && state?.preferences.microphoneMode === "pushToTalk";
  releaseDelayEnabled.disabled = !delayAvailable;
  releaseDelayEnabled.checked = delayMs > 0;
  releaseDelay.disabled = !delayAvailable || delayMs === 0;
  releaseDelay.value = String(delayMs);
  releaseDelay.setAttribute("aria-valuetext", `${delayMs} ms`);
  element("push-to-talk-delay-value").textContent = `${delayMs} ms`;
}

async function receiveDesktopLink() {
  const target = await invoke<DesktopLink | null>("take_desktop_link");
  if (!target) return;
  pendingDesktopLink = target;
  renderInstallations();
  if (state?.preferences.installations.some((saved) => saved.id === target.id)) {
    if (busy) deferredDesktopLink = target;
    else await openDesktopLink(target);
  }
}

async function openDesktopLink(target: DesktopLink) {
  await run(async () => {
    state = await invoke<Snapshot>("save_installation", { address: target.origin });
    attemptedConnection = target;
    status("checking");
    const next = await transition((confirmed) => openConnection(target, {
      id: target.id, confirmLeave: confirmed, reload: false, desktopLaunch: target.launchId
    }));
    if (next) {
      state = next; failedConnection = null;
      if (pendingDesktopLink === target) pendingDesktopLink = null;
      element("status").textContent = "";
    }
  });
}

element("desktop-link-review").addEventListener("click", () => {
  if (busy || !pendingDesktopLink) return;
  void openDesktopLink(pendingDesktopLink);
});
element("desktop-link-dismiss").addEventListener("click", () => {
  if (busy) return;
  pendingDesktopLink = null;
  renderInstallations();
  element("address").focus();
});

function localMediaActive(): boolean {
  return captures.isPending() || Boolean(captures.current()) || Boolean(toneContext && toneContext.state !== "closed");
}

async function confirmAction(quitting = false, report: CallState | null = null, updating = false): Promise<boolean> {
  if (confirmPending) return false;
  confirmPending = true;
  const dialog = element<HTMLDialogElement>("confirm-dialog");
  const opener = document.activeElement as HTMLElement | null;
  const details: TranslationKey[] = [];
  if (state?.active && !report) details.push("callStateUnknown");
  if (report?.inVoice) details.push("callStateVoice");
  if (report?.microphone) details.push("callStateMicrophone");
  if (report?.camera) details.push("callStateCamera");
  if (report?.screen) details.push("callStateScreen");
  if (report?.computerAudio) details.push("callStateComputerAudio");
  if (report?.capture && !report.microphone && !report.camera && !report.screen) details.push("callStateCapture");
  if (report?.pendingJoin || report?.pendingCapture) details.push("callStatePending");
  if (report?.microphoneTest) details.push("callStateTest");
  if (localMediaActive()) details.push("callStateLocalMedia");
  element("confirm-body").textContent = [t(updating ? "updateConfirmation" : quitting ? "quitConfirmationBody" : "confirmationBody"), ...details.map(t)].join(" ");
  element("confirm-title").textContent = t(updating ? "updateInstall" : quitting ? "quit" : "confirmationTitle");
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
  const opener = document.activeElement as HTMLElement | null;
  const focusKey = opener?.dataset.focusKey;
  busy = true;
  renderInstallations();
  try { await action(); } catch (error: unknown) {
    status(errorKey(error));
    if (String(error) === "connection_cancelled") return;
    if (attemptedConnection) {
      failedConnection = attemptedConnection;
      element("status").textContent = `${t("connectionFailed")} ${failedConnection.origin}. ${t(errorKey(error))}`;
    }
  }
  finally {
    busy = false;
    attemptedConnection = null;
    renderLoading();
    renderInstallations();
    const target = focusKey
      ? [...element("installation-list").querySelectorAll<HTMLElement>("[data-focus-key]")].find((button) => button.dataset.focusKey === focusKey)
      : opener;
    (loadingTarget ? element("cancel-connection") : target?.isConnected ? target : element("address"))?.focus();
    if (pendingQuit) { pendingQuit = false; queueMicrotask(() => void quit()); }
    else if (deferredDesktopLink) {
      const target = deferredDesktopLink; deferredDesktopLink = null;
      if (pendingDesktopLink === target) queueMicrotask(() => void openDesktopLink(target));
    }
  }
}

async function transition<T>(action: (confirmed: boolean) => Promise<T>, quitting = false): Promise<T | undefined> {
  return performTransition({
    active: Boolean(state?.active),
    report: () => invoke<CallState | null>("transition_state"),
    localMedia: localMediaActive,
    confirm: (report) => confirmAction(quitting, report),
    stop: stopMedia,
    action
  });
}

async function connect(saved: Installation, reload = false) {
  attemptedConnection = saved;
  await run(async () => {
    const changing = state?.active && (state.active.id !== saved.id || reload);
    status("checking");
    const open = (confirmed: boolean) => openConnection(saved, { id: saved.id, address: saved.origin, confirmLeave: confirmed, reload });
    const next = changing || !state?.active ? await transition(open) : await open(false);
    if (next) { state = next; failedConnection = null; }
    element("status").textContent = "";
  });
}

element("installation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    const address = element<HTMLInputElement>("address").value.trim();
    const name = element<HTMLInputElement>("installation-name").value.trim();
    if (element<HTMLInputElement>("remember").checked) state = await invoke<Snapshot>("save_installation", { address, name });
    attemptedConnection = { id: "", origin: address };
    status("checking");
    const next = await transition((confirmed) => openConnection({ id: "", origin: address }, { id: "", address, confirmLeave: confirmed, reload: false }));
    if (next) {
      state = next; failedConnection = null; element<HTMLInputElement>("address").value = "";
      element<HTMLInputElement>("installation-name").value = ""; element("status").textContent = "";
    }
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
  void run(async () => {
    const next = await transition((confirmed) => invoke<Snapshot>("disconnect_installation", { confirmLeave: confirmed }));
    if (next) state = next;
  });
});
element("retry").addEventListener("click", () => { if (state?.active) void connect(state.active, true); });

async function quit() {
  if (busy) { pendingQuit = true; if (loadingTarget) void cancelLoading().catch((error) => status(errorKey(error))); return; }
  if (state?.loading) await cancelLoading();
  await run(async () => {
    await transition((confirmed) => invoke("quit_app", { confirmLeave: confirmed }), true);
  });
}

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
  if (busy) return;
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
    captures.finish(ticket);
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
  if (busy) return;
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
  // Explicit developer entry; probes never appear in the production Home path.
  element("diagnostics").hidden = !(import.meta.env.DEV && new URLSearchParams(location.search).has("diagnostics"));
  if (!native) { booting = false; renderLoading(); return; }
  try {
    // Subscribe before reading the cached startup request so neither a cold
    // launch nor a forwarded request races the chooser's first render.
    await listen("shell:desktop-link", () => {
      void receiveDesktopLink().catch((error: unknown) => status(errorKey(error)));
    });
    state = await invoke<Snapshot>("shell_state");
    updateState = await invoke<UpdateSnapshot>("shell_update_state");
    language = state.preferences.language;
    renderTranslations();
    renderInstallations();
    await listen<Snapshot>("shell:ready", (event) => {
      state = event.payload; receivedReady = event.payload; loadingTarget = null; booting = false; renderInstallations();
    });
    await listen("shell:show-home", () => { booting = false; loadingTarget = null; renderLoading(); });
    await listen("shell:check-update", () => {
      booting = false; loadingTarget = null; renderLoading();
      element("updates-heading").scrollIntoView({ block: "center" });
      element("update-check").focus();
    });
    await listen<Installation>("shell:load-failed", (event) => {
      loadingTarget = null; booting = false;
      failedConnection = event.payload;
      element("status").textContent = `${t("connectionFailed")} ${event.payload.origin}. ${t("window_failed")}`;
      renderInstallations();
      void invoke<Snapshot>("shell_state").then((next) => { state = next; renderInstallations(); }).catch((error) => status(errorKey(error)));
    });
    await listen("shell:preferences", () => {
      void invoke<Snapshot>("shell_state").then((next) => { state = next; renderInstallations(); }).catch((error) => status(errorKey(error)));
    });
    await listen("shell:quit-requested", () => void quit());
    await listen<UpdateSnapshot>("shell:updates", (event) => { updateState = event.payload; renderUpdates(); });
    await listen("shell:review-update", () => {
      void invoke<UpdateSnapshot>("shell_update_state").then((next) => {
        updateState = next; renderUpdates();
        element("updates-heading").scrollIntoView({ block: "center" });
        if (next.phase === "ready" && !confirmPending) element("update-install").click();
      }).catch((error: unknown) => status(errorKey(error)));
    });
    await receiveDesktopLink();
    const preferred = startupInstallation(state, pendingDesktopLink);
    if (preferred) await connect(preferred);
    booting = false; renderLoading();
    refreshReport();
    // Cover a native background transition between the initial read and subscription.
    updateState = await invoke<UpdateSnapshot>("shell_update_state");
    renderUpdates();
    if (!state.active && !state.preferences.trayAcknowledged) {
      const dialog = element<HTMLDialogElement>("tray-dialog");
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "confirm") void run(async () => { state = await invoke<Snapshot>("acknowledge_tray"); });
      });
      dialog.showModal();
    }
  } catch (error: unknown) { booting = false; loadingTarget = null; renderLoading(); status(errorKey(error)); }
}
void start();

element("launch-default").addEventListener("click", () => {
  const saved = state?.preferences.installations.find((entry) => entry.id === state?.preferences.defaultInstallationId);
  if (saved) void connect(saved);
});
element("open-startup").addEventListener("change", () => {
  const enabled = element<HTMLInputElement>("open-startup").checked;
  void run(async () => {
    state = await invoke<Snapshot>("desktop_settings", { operation: { kind: "default", id: state?.preferences.defaultInstallationId, enabled } });
  });
});
for (const id of ["full-addresses", "compact-list", "installation-icons"]) {
  element(id).addEventListener("change", () => {
    const display = {
      fullAddresses: element<HTMLInputElement>("full-addresses").checked,
      compactList: element<HTMLInputElement>("compact-list").checked,
      installationIcons: element<HTMLInputElement>("installation-icons").checked
    };
    void run(async () => { state = await invoke<Snapshot>("desktop_settings", { operation: { kind: "display", display } }); });
  });
}
element("choose-another").addEventListener("click", () => { failedConnection = null; element("connection-recovery").hidden = true; element("status").textContent = ""; element("address").focus(); });
element("retry-failed").addEventListener("click", () => { if (failedConnection) void connect(failedConnection, state?.active?.id === failedConnection.id); });
element("rename-cancel").addEventListener("click", () => element<HTMLDialogElement>("rename-dialog").close());
element("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!renaming) return;
  void invoke<Snapshot>("desktop_settings", { operation: { kind: "rename", id: renaming.id, name: element<HTMLInputElement>("rename-name").value } })
    .then((next) => { state = next; element<HTMLDialogElement>("rename-dialog").close(); renderInstallations(); })
    .catch((error) => { element("rename-status").textContent = t(errorKey(error)); });
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") document.querySelectorAll<HTMLDetailsElement>(".installation-menu[open], .display-menu[open]").forEach((menu) => { menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); }); });
document.addEventListener("click", (event) => document.querySelectorAll<HTMLDetailsElement>(".installation-menu[open], .display-menu[open]").forEach((menu) => { if (!menu.contains(event.target as Node)) menu.open = false; }));

element("rename-dialog").addEventListener("close", () => {
  const key = `${renaming?.id}:menu`;
  renaming = null;
  const trigger = [...element("installation-list").querySelectorAll<HTMLElement>("summary")].find((node) => node.dataset.focusKey === key);
  (trigger ?? element("address")).focus();
});
