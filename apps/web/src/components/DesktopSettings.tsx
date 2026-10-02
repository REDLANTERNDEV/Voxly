import { useEffect, useRef, useState } from "react";
import type { Translate } from "../app/types.js";
import { HomeIcon, ExternalLinkIcon, CloseIcon, RefreshIcon } from "./ui/Icons.js";
import { applyDesktopSettings, desktopSettingsAvailable, desktopBindingLabel, desktopKeyboardBinding, desktopMouseBinding, type DesktopAction, type DesktopSettingsOperation, type DesktopSettingsSnapshot } from "../lib/desktopSettings.js";

function useDesktopSettings() {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    if (desktopSettingsAvailable(window)) void applyDesktopSettings({ kind: "read" }).then((next) => { if (live.current) setSnapshot(next); }).catch(() => { if (live.current) setError("failed"); });
    return () => { live.current = false; };
  }, []);
  async function save(operation: DesktopSettingsOperation) {
    setPending(true); setError("");
    try {
      const next = await applyDesktopSettings(operation);
      if (live.current) setSnapshot(next);
      return true;
    } catch (error) {
      if (live.current) setError(typeof error === "string" ? error : "failed");
      try { const next = await applyDesktopSettings({ kind: "read" }); if (live.current) setSnapshot(next); } catch { /* Keep last usable snapshot. */ }
      return false;
    } finally { if (live.current) setPending(false); }
  }
  return { snapshot, pending, error, save };
}
function Feedback({ error, t }: { error: string; t: Translate }) {
  return error ? <p className="error-text small" role="alert">{t(error === "shortcut_duplicate" ? "desktopSettings.duplicate" : error === "shortcut_required" ? "desktopSettings.required" : error === "shortcut_unavailable" ? "desktopSettings.conflict" : "desktopSettings.failed")}</p> : null;
}
export function DesktopHomeButton({ t, onOpened }: { t: Translate; onOpened?: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <>
    <button className="settings-nav-item settings-home" type="button" disabled={pending} onClick={() => {
      setPending(true); setError(false);
      void applyDesktopSettings({ kind: "home" }).then(onOpened).catch(() => setError(true)).finally(() => setPending(false));
    }}><span className="settings-nav-icon" aria-hidden="true"><HomeIcon /></span><span className="settings-home-label">{t("desktopSettings.home")}<ExternalLinkIcon /></span></button>
    {error ? <p className="error-text small" role="alert">{t("desktopSettings.failed")}</p> : null}
  </>;
}
export function DesktopMicrophoneSettings({ t, onShortcuts }: { t: Translate; onShortcuts: () => void }) {
  const { snapshot, pending, error, save } = useDesktopSettings();
  const preferences = snapshot?.preferences;
  const [delay, setDelay] = useState(0);
  useEffect(() => { setDelay(preferences?.pushToTalkReleaseDelayMs ?? 0); }, [preferences?.pushToTalkReleaseDelayMs]);
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <div className="desktop-microphone-settings">
    <label className="form-field"><span>{t("desktopSettings.mode")}</span><select className="input" disabled={!preferences || pending} value={preferences?.microphoneMode ?? "openMic"} onChange={(event) => void save({ kind: "microphone", mode: event.target.value as NonNullable<typeof preferences>["microphoneMode"] })}>
      <option value="openMic">{t("desktopSettings.openMic")}</option><option value="pushToTalk">{t("desktopSettings.pushToTalk")}</option><option value="pushToMute">{t("desktopSettings.pushToMute")}</option>
    </select></label>
    {preferences?.microphoneMode === "pushToTalk" ? <div className="desktop-release-delay">
      <label className="audio-toggle-control"><span>{t("desktopSettings.delayEnabled")}</span><input type="checkbox" checked={delay > 0} disabled={pending} onChange={(event) => void save({ kind: "delay", milliseconds: event.target.checked ? 200 : 0 })} /></label>
      <label className="audio-level-control"><span><span>{t("desktopSettings.delay")}</span><strong>{delay} ms</strong></span><input type="range" min={0} max={2000} step={10} value={delay} disabled={pending || delay === 0} aria-valuetext={`${delay} ms`} onChange={(event) => setDelay(Number(event.target.value))} onPointerUp={() => void save({ kind: "delay", milliseconds: delay })} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void save({ kind: "delay", milliseconds: delay }); }} /></label>
    </div> : null}
    {preferences?.microphoneMode !== "openMic" ? <button type="button" className="btn btn-ghost desktop-settings-link" onClick={onShortcuts}>{t("desktopSettings.editShortcuts")}</button> : null}
    <Feedback error={error} t={t} />
  </div>;
}
const actions = ["mute", "deafen", "pushToTalk", "pushToMute"] as const;
function ShortcutRow({ action, snapshot, pending, save, t, recording, onRecording, onAudio }: {
  action: DesktopAction; snapshot: DesktopSettingsSnapshot | null; pending: boolean; save: (operation: DesktopSettingsOperation) => Promise<boolean>;
  t: Translate; recording: boolean; onRecording: (action: DesktopAction | null) => void; onAudio: () => void;
}) {
  const [draft, setDraft] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const [recordError, setRecordError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const binding = snapshot?.preferences[`${action}Shortcut`];
  const registration = snapshot?.[({ mute: "registeredMuteShortcut", deafen: "registeredDeafenShortcut", pushToTalk: "registeredPushToTalkShortcut", pushToMute: "registeredPushToMuteShortcut" } as const)[action]];
  useEffect(() => {
    if (!recording) return;
    let live = true;
    void applyDesktopSettings({ kind: "recording", enabled: true }).then(() => { if (live) input.current?.focus(); }).catch(() => { if (live) { setRecordError(true); onRecording(null); } });
    let suppressed: number | null = null;
    const mouse = (event: MouseEvent) => {
      const value = desktopMouseBinding(event);
      if (!value) return;
      event.preventDefault(); event.stopPropagation(); suppressed = event.button;
      setDraft(value); setInvalid(false);
    };
    const release = (event: MouseEvent) => { if (event.button === suppressed) { event.preventDefault(); event.stopPropagation(); } };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onRecording(null); edit.current?.focus(); return; }
      if (event.key === "Tab" || event.target !== input.current && ["Enter", " "].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const value = desktopKeyboardBinding(event);
      if (value) { setDraft(value); setInvalid(false); }
      else if (!event.repeat && !/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) setInvalid(true);
    };
    const blur = () => onRecording(null);
    window.addEventListener("keydown", key, true); window.addEventListener("mousedown", mouse, true); window.addEventListener("mouseup", release, true); window.addEventListener("auxclick", release, true); window.addEventListener("blur", blur);
    return () => {
      live = false;
      void applyDesktopSettings({ kind: "recording", enabled: false }).catch(() => undefined);
      window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", mouse, true); window.removeEventListener("mouseup", release, true); window.removeEventListener("auxclick", release, true); window.removeEventListener("blur", blur);
    };
  }, [recording, onRecording]);
  async function stop() {
    if (invalid) { input.current?.focus(); return; }
    onRecording(null);
    if (draft) await save({ kind: "shortcut", action, binding: draft });
    edit.current?.focus();
  }
  const warning = recordError ? "desktopSettings.failed" : invalid && recording ? "desktopSettings.invalid" : binding && !registration ? "desktopSettings.conflict" : null;
  return <div className={`desktop-shortcut-row ${recording ? "is-recording" : ""}`}>
    <div className="desktop-shortcut-description"><strong>{t(`desktopSettings.${action}`)}</strong>
      {action === "pushToTalk" || action === "pushToMute" ? <button type="button" className="btn btn-ghost desktop-audio-button" onClick={onAudio}>{t("desktopSettings.editAudio")}</button> : null}
    </div>
    <div className="desktop-shortcut-controls">
      <div className="desktop-shortcut-binding"><input ref={input} className="input" aria-label={t(`desktopSettings.${action}`)} readOnly value={recording ? draft ? desktopBindingLabel(draft) : t("desktopSettings.press") : binding ? desktopBindingLabel(binding) : t("desktopSettings.none")} />
        {binding && !recording ? <button type="button" className="icon-btn" disabled={pending} aria-label={`${t("desktopSettings.clear")}: ${t(`desktopSettings.${action}`)}`} title={t("desktopSettings.clear")} onClick={() => void save({ kind: "shortcut", action, binding: null })}><CloseIcon /></button> : null}
      </div>
      <div className="desktop-shortcut-actions">
      <button ref={edit} type="button" className="btn desktop-record-button" disabled={!snapshot || pending} aria-pressed={recording} onClick={() => {
        if (recording) void stop();
        else { setDraft(undefined); setInvalid(false); setRecordError(false); onRecording(action); }
      }}>{t(recording ? "desktopSettings.stopRecording" : "desktopSettings.editKeybind")}</button>
      <button type="button" className="icon-btn desktop-shortcut-reset" disabled={!snapshot || pending || recording} title={t("desktopSettings.reset")} aria-label={`${t("desktopSettings.reset")}: ${t(`desktopSettings.${action}`)}`} onClick={() => void save({ kind: "resetShortcut", action })}><RefreshIcon /></button>
      </div>
    </div>
    <p className={`desktop-shortcut-status small ${warning ? "error-text" : "muted"}`} role="status">{warning ? t(warning) : recording ? t("desktopSettings.recordingHint") : registration ? t("desktopSettings.active") : ""}</p>
  </div>;
}
export function DesktopShortcutSettings({ t, onAudio }: { t: Translate; onAudio: () => void }) {
  const { snapshot, pending, error, save } = useDesktopSettings();
  const [recordingAction, setRecordingAction] = useState<DesktopAction | null>(null);
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <section className="desktop-shortcut-settings"><p className="muted small">{t("desktopSettings.shortcutHint")}</p>
    <div className="desktop-shortcut-list">{actions.map((action) => <ShortcutRow key={action} action={action} snapshot={snapshot} pending={pending} save={save} t={t} recording={recordingAction === action} onRecording={setRecordingAction} onAudio={onAudio} />)}</div>
    <Feedback error={error} t={t} />
  </section>;
}
