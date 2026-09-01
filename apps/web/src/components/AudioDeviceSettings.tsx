import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { audioDeviceDisplayName, type AudioDevicePreferenceKind } from "../lib/audioDevices.js";
import { clampContextMenuPosition } from "../lib/contextMenu.js";
import { MAX_NOTIFICATION_VOLUME_PERCENT, type NotificationSoundPreferences } from "../lib/notificationSounds.js";
import type { MicrophoneTestError } from "../lib/useMicrophoneTest.js";

interface AudioDeviceSettingsProps {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppression: boolean;
  noiseSuppressionSupported: boolean;
  notificationSounds: NotificationSoundPreferences;
  microphoneTestActive: boolean;
  microphoneTestError: MicrophoneTestError;
  loading: boolean;
  error: string;
  unavailableSelections: AudioDevicePreferenceKind[];
  outputSelectionSupported: boolean;
  labels: {
    title: string;
    microphone: string;
    output: string;
    inputVolume: string;
    outputVolume: string;
    noiseSuppression: string;
    noiseSuppressionHint: string;
    noiseSuppressionUnsupported: string;
    notificationSounds: string;
    notificationSoundsHint: string;
    notificationVolume: string;
    notificationVoice: string;
    notificationMessage: string;
    notificationConnection: string;
    systemDefault: string;
    browserControlled: string;
    refresh: string;
    unavailable: string;
    startTest: string;
    stopTest: string;
    testHint: string;
    testPermission: string;
    testUnavailable: string;
    closeSettings: string;
  };
  onOpen(): Promise<unknown>;
  onClose(): void;
  onRefresh(): Promise<unknown>;
  onSelectInput(deviceId: string): void;
  onSelectOutput(deviceId: string): Promise<void>;
  onInputVolumeChange(volume: number): void;
  onOutputVolumeChange(volume: number): void;
  onNoiseSuppressionChange(enabled: boolean): void;
  onNotificationSoundsChange(patch: Partial<NotificationSoundPreferences>): void;
  onToggleMicrophoneTest(): Promise<void>;
}

function AudioLevelControl({ label, value, max = 200, onChange }: { label: string; value: number; max?: number; onChange: (value: number) => void }) {
  return (
    <label className="audio-level-control">
      <span><span>{label}</span><strong>{value}%</strong></span>
      <input aria-label={label} type="range" min="0" max={max} step="1" value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </label>
  );
}

function AudioSwitchControl({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const labelId = useId();
  return (
    <div className="audio-toggle-control">
      <span id={labelId}>{label}</span>
      <button
        className={`audio-switch ${checked ? "is-on" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        onClick={() => onChange(!checked)}
      ><span aria-hidden="true" /></button>
      {hint ? <span className="muted small">{hint}</span> : null}
    </div>
  );
}

export function AudioDeviceSettings(props: AudioDeviceSettingsProps & { inline?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320 });
  const noiseSuppressionLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    props.onClose();
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [props.onClose]);

  const open = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const height = Math.min(640, window.innerHeight - 16);
    const next = clampContextMenuPosition({
      x: rect?.left ?? 8,
      y: (rect?.top ?? window.innerHeight) - height - 8,
      menuWidth: width,
      menuHeight: height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    });
    setPosition({ left: next.x, top: next.y, width });
    setIsOpen(true);
    void props.onOpen().catch(() => undefined);
  }, [props.onOpen]);

  // Inline has no "open" moment, so it refreshes on mount instead — otherwise
  // the member sees an empty device list until something else happens to ask.
  //
  // Through a ref, because callers build `onOpen` inline and a fresh identity
  // every render would turn this into an enumeration loop.
  const inline = props.inline === true;
  const requestDevicesRef = useRef(props.onOpen);
  requestDevicesRef.current = props.onOpen;
  useEffect(() => {
    if (!inline) return;
    void requestDevicesRef.current().catch(() => undefined);
  }, [inline]);

  useEffect(() => {
    if (!isOpen) return;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", close);
    };
  }, [close, isOpen]);

  const deviceStatus = props.error || (props.unavailableSelections.length > 0 ? props.labels.unavailable : "");
  const testStatus = props.microphoneTestError === "permission"
    ? props.labels.testPermission
    : props.microphoneTestError === "unavailable"
      ? props.labels.testUnavailable
      : "";

  const fields = (
          <div className="audio-device-fields">
            <label className="form-field">
              <span>{props.labels.microphone}</span>
              <select className="input" name="audioInput" value={props.selectedInputId} onChange={(event) => props.onSelectInput(event.currentTarget.value)}>
                <option value="">{props.labels.systemDefault}</option>
                {props.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{audioDeviceDisplayName(device, props.labels.microphone, index)}</option>)}
              </select>
            </label>
            <AudioLevelControl label={props.labels.inputVolume} value={props.inputVolume} onChange={props.onInputVolumeChange} />
            <div className="audio-toggle-control">
              <span id={noiseSuppressionLabelId}>{props.labels.noiseSuppression}</span>
              <button
                className={`audio-switch ${props.noiseSuppression ? "is-on" : ""}`}
                type="button"
                role="switch"
                aria-checked={props.noiseSuppression}
                aria-labelledby={noiseSuppressionLabelId}
                disabled={!props.noiseSuppressionSupported}
                onClick={() => props.onNoiseSuppressionChange(!props.noiseSuppression)}
              ><span aria-hidden="true" /></button>
              <span className="muted small">{props.noiseSuppressionSupported ? props.labels.noiseSuppressionHint : props.labels.noiseSuppressionUnsupported}</span>
            </div>
            <div className="microphone-test-control">
              <button className={`btn ${props.microphoneTestActive ? "btn-danger" : "btn-ghost"}`} type="button" disabled={testPending} aria-pressed={props.microphoneTestActive} onClick={() => {
                setTestPending(true);
                void props.onToggleMicrophoneTest().finally(() => setTestPending(false));
              }}>{props.microphoneTestActive ? props.labels.stopTest : props.labels.startTest}</button>
              <span className="muted small">{props.labels.testHint}</span>
            </div>
            <label className="form-field">
              <span>{props.labels.output}</span>
              <select className="input" name="audioOutput" value={props.selectedOutputId} disabled={!props.outputSelectionSupported} onChange={(event) => void props.onSelectOutput(event.currentTarget.value).catch(() => undefined)}>
                <option value="">{props.outputSelectionSupported ? props.labels.systemDefault : props.labels.browserControlled}</option>
                {props.outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{audioDeviceDisplayName(device, props.labels.output, index)}</option>)}
              </select>
            </label>
            <AudioLevelControl label={props.labels.outputVolume} value={props.outputVolume} onChange={props.onOutputVolumeChange} />
            <div className="notification-sound-section">
              <AudioSwitchControl
                label={props.labels.notificationSounds}
                hint={props.labels.notificationSoundsHint}
                checked={props.notificationSounds.enabled}
                onChange={(enabled) => props.onNotificationSoundsChange({ enabled })}
              />
              {props.notificationSounds.enabled ? (
                <>
                  <AudioLevelControl
                    label={props.labels.notificationVolume}
                    value={props.notificationSounds.volume}
                    max={MAX_NOTIFICATION_VOLUME_PERCENT}
                    onChange={(volume) => props.onNotificationSoundsChange({ volume })}
                  />
                  <AudioSwitchControl label={props.labels.notificationVoice} checked={props.notificationSounds.voice} onChange={(voice) => props.onNotificationSoundsChange({ voice })} />
                  <AudioSwitchControl label={props.labels.notificationMessage} checked={props.notificationSounds.message} onChange={(message) => props.onNotificationSoundsChange({ message })} />
                  <AudioSwitchControl label={props.labels.notificationConnection} checked={props.notificationSounds.connection} onChange={(connection) => props.onNotificationSoundsChange({ connection })} />
                </>
              ) : null}
            </div>
            <button className="btn btn-ghost" type="button" disabled={props.loading} onClick={() => void props.onRefresh()}>{props.loading ? `${props.labels.refresh}…` : props.labels.refresh}</button>
            <p className="error-text" aria-live="polite">{deviceStatus || testStatus}</p>
          </div>
  );

  // Inside the settings window there is nothing to pop over: the page *is* the
  // place these belong, and a popover inside a dialog is a second layer over a
  // first for no reason. Same controls, no trigger, no portal.
  if (props.inline) {
    return (
      <section className="theme-card audio-device-card is-inline">
        <div className="theme-card-head"><span className="label">{props.labels.title}</span></div>
        {fields}
      </section>
    );
  }

  return (
    <section className="audio-device-card">
      <button ref={triggerRef} className="audio-device-trigger" type="button" aria-haspopup="dialog" aria-expanded={isOpen} onClick={() => isOpen ? close() : open()}>
        <span>{props.labels.title}</span><span aria-hidden="true">{isOpen ? "−" : "+"}</span>
      </button>
      {isOpen ? createPortal(
        <div ref={popoverRef} className="audio-device-popover" role="dialog" aria-label={props.labels.title} style={position}>
          <div className="audio-device-popover-head">
            <strong>{props.labels.title}</strong>
            <button ref={closeButtonRef} className="audio-device-close" type="button" aria-label={props.labels.closeSettings} onClick={close}>×</button>
          </div>
          {fields}
        </div>,
        document.body
      ) : null}
    </section>
  );
}
