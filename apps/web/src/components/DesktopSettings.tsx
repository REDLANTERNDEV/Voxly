import { useEffect, useRef, useState } from "react";
import type { Translate } from "../app/types.js";
import { applyDesktopSettings, desktopSettingsAvailable, desktopBindingLabel, desktopKeyboardBinding, desktopMouseBinding, type DesktopAction, type DesktopSettingsOperation, type DesktopSettingsSnapshot } from "../lib/desktopSettings.js";

function useDesktopSettings() {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void applyDesktopSettings({ kind: "read" }).then((next) => { if (live) setSnapshot(next); }).catch(() => { if (live) setError("failed"); });
    return () => { live = false; };
  }, []);
  async function save(operation: DesktopSettingsOperation) {
    setPending(true); setError("");
    try { setSnapshot(await applyDesktopSettings(operation)); }
    catch (error) {
      setError(typeof error === "string" ? error : "failed");
      try { setSnapshot(await applyDesktopSettings({ kind: "read" })); } catch { /* Keep last usable snapshot. */ }
    } finally { setPending(false); }
  }
  return { snapshot, pending, error, save };
}
function Feedback({ error, t }: { error: string; t: Translate }) {
  return <p className="muted small" role="status">{error ? t(error === "shortcut_duplicate" ? "desktopSettings.duplicate" : error === "shortcut_required" ? "desktopSettings.required" : error === "shortcut_unavailable" ? "desktopSettings.conflict" : "desktopSettings.failed") : ""}</p>;
}
export function DesktopPreferences({ t }: { t: Translate }) {
  const { snapshot, pending, error, save } = useDesktopSettings();
  const preferences = snapshot?.preferences;
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <section className="theme-card">
    <h3 className="label">{t("settings.desktop")}</h3><p className="muted small">{t("desktopSettings.local")}</p>
    <label className="field"><span>{t("desktopSettings.default")}</span><select disabled={!preferences || pending} value={preferences?.defaultInstallationId ?? ""} onChange={(event) => void save({ kind: "default", id: event.target.value || null, enabled: preferences?.openOnStartup ?? false })}>
      <option value="">{t("desktopSettings.none")}</option>{preferences?.installations.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || entry.origin}</option>)}
    </select></label>
    <label className="field"><span>{t("desktopSettings.startup")}</span><input type="checkbox" checked={preferences?.openOnStartup ?? false} disabled={!preferences?.defaultInstallationId || pending} onChange={(event) => void save({ kind: "default", id: preferences?.defaultInstallationId ?? null, enabled: event.target.checked })} /></label>
    <button type="button" className="btn" disabled={pending} onClick={() => void save({ kind: "home" })}>{t("desktopSettings.home")}</button><Feedback error={error} t={t} />
  </section>;
}
export function DesktopMicrophoneSettings({ t, onShortcuts }: { t: Translate; onShortcuts: () => void }) {
  const { snapshot, pending, error, save } = useDesktopSettings();
  const preferences = snapshot?.preferences;
  const [delay, setDelay] = useState(0);
  useEffect(() => { setDelay(preferences?.pushToTalkReleaseDelayMs ?? 0); }, [preferences?.pushToTalkReleaseDelayMs]);
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <section className="theme-card"><h3 className="label">{t("desktopSettings.microphone")}</h3><p className="muted small">{t("desktopSettings.modeHint")}</p>
    <label className="field"><span>{t("desktopSettings.mode")}</span><select disabled={!preferences || pending} value={preferences?.microphoneMode ?? "openMic"} onChange={(event) => void save({ kind: "microphone", mode: event.target.value as NonNullable<typeof preferences>["microphoneMode"] })}>
      <option value="openMic">{t("desktopSettings.openMic")}</option><option value="pushToTalk">{t("desktopSettings.pushToTalk")}</option><option value="pushToMute">{t("desktopSettings.pushToMute")}</option>
    </select></label>
    {preferences?.microphoneMode === "pushToTalk" ? <>
      <label className="field"><span>{t("desktopSettings.delayEnabled")}</span><input type="checkbox" checked={delay > 0} disabled={pending} onChange={(event) => void save({ kind: "delay", milliseconds: event.target.checked ? 200 : 0 })} /></label>
      <label className="field"><span>{t("desktopSettings.delay")} · {delay} ms</span><input type="range" min={0} max={2000} step={10} value={delay} disabled={pending || delay === 0} aria-valuetext={`${delay} ms`} onChange={(event) => setDelay(Number(event.target.value))} onPointerUp={() => void save({ kind: "delay", milliseconds: delay })} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void save({ kind: "delay", milliseconds: delay }); }} /></label>
    </> : null}
    <button type="button" className="btn btn-ghost" onClick={onShortcuts}>{t("desktopSettings.editShortcuts")}</button><Feedback error={error} t={t} />
  </section>;
}
const actions = ["mute", "deafen", "pushToTalk", "pushToMute"] as const;
function ShortcutRow({ action, snapshot, pending, save, t }: { action: DesktopAction; snapshot: DesktopSettingsSnapshot | null; pending: boolean; save: (operation: DesktopSettingsOperation) => Promise<void>; t: Translate }) {
  const [recording, setRecording] = useState(false);
  const [draft, setDraft] = useState<string | undefined>();
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (draft !== undefined && !recording) saveButton.current?.focus(); }, [draft, recording]);
  const binding = snapshot?.preferences[`${action}Shortcut`];
  const registration = snapshot?.[({ mute: "registeredMuteShortcut", deafen: "registeredDeafenShortcut", pushToTalk: "registeredPushToTalkShortcut", pushToMute: "registeredPushToMuteShortcut" } as const)[action]];
  useEffect(() => {
    if (!recording) return;
    let live = true;
    // Native delivery pauses only new presses while this focused recorder is active.
    void applyDesktopSettings({ kind: "recording", enabled: true }).then(() => { if (live) input.current?.focus(); }).catch(() => setRecording(false));
    let suppressed: number | null = null;
    const mouse = (event: MouseEvent) => {
      const value = desktopMouseBinding(event);
      if (!value) return;
      event.preventDefault(); event.stopPropagation(); suppressed = event.button;
      setDraft(value); setRecording(false); setInvalid(false);
      saveButton.current?.focus();
    };
    const release = (event: MouseEvent) => { if (event.button === suppressed) { event.preventDefault(); event.stopPropagation(); } };
    const blur = () => setRecording(false);
    window.addEventListener("mousedown", mouse, true); window.addEventListener("mouseup", release, true); window.addEventListener("auxclick", release, true); window.addEventListener("blur", blur);
    return () => {
      live = false;
      void applyDesktopSettings({ kind: "recording", enabled: false }).catch(() => undefined);
      window.removeEventListener("mousedown", mouse, true); window.removeEventListener("mouseup", release, true); window.removeEventListener("auxclick", release, true); window.removeEventListener("blur", blur);
    };
  }, [recording]);
  async function persist(binding: string | null) { setDraft(undefined); await save({ kind: "shortcut", action, binding }); recordButton.current?.focus(); }
  return <div className="theme-card desktop-shortcut-row"><label className="field"><span>{t(`desktopSettings.${action}`)}</span><input ref={input} readOnly value={recording ? t("desktopSettings.press") : draft || binding ? desktopBindingLabel(draft ?? binding!) : t("desktopSettings.none")} onBlur={(event) => { if (event.relatedTarget !== recordButton.current) setRecording(false); }} onKeyDown={(event) => {
    if (!recording) return;
    if (event.key === "Tab" || event.key === "Escape") { setRecording(false); if (event.key === "Escape") { event.preventDefault(); recordButton.current?.focus(); } return; }
    event.preventDefault(); const value = desktopKeyboardBinding(event.nativeEvent);
    if (!value) { if (!/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) setInvalid(true); return; }
    setDraft(value); setRecording(false); setInvalid(false); saveButton.current?.focus();
  }} /></label>
    <div className="actions"><button ref={recordButton} type="button" className="btn" disabled={!snapshot || pending} onClick={() => { setRecording(!recording); setInvalid(false); }}>{t(recording ? "common.cancel" : "desktopSettings.record")}</button>
      <button ref={saveButton} type="button" className="btn" disabled={pending || draft === undefined || recording} onClick={() => void persist(draft!)}>{t("desktopSettings.save")}</button>
      <button type="button" className="btn btn-ghost" disabled={pending || !binding || recording} onClick={() => void persist(null)}>{t("desktopSettings.clear")}</button></div>
    <p className="muted small" role="status">{t(invalid ? "desktopSettings.invalid" : draft ? "desktopSettings.draft" : registration ? "desktopSettings.active" : binding ? "desktopSettings.conflict" : "desktopSettings.none")}</p>
  </div>;
}
export function DesktopShortcutSettings({ t, onAudio }: { t: Translate; onAudio: () => void }) {
  const { snapshot, pending, error, save } = useDesktopSettings();
  if (typeof window === "undefined" || !desktopSettingsAvailable(window)) return null;
  return <section><p className="muted small">{t("desktopSettings.shortcutHint")}</p>{actions.map((action) => <ShortcutRow key={action} action={action} snapshot={snapshot} pending={pending} save={save} t={t} />)}<button type="button" className="btn btn-ghost" onClick={onAudio}>{t("desktopSettings.editAudio")}</button><Feedback error={error} t={t} /></section>;
}
