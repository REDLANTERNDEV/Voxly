import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { audioDeviceDisplayName, type AudioDevicePreferenceKind } from "../lib/audioDevices.js";
import { clampContextMenuPosition } from "../lib/contextMenu.js";
import type { MicrophoneTestError } from "../lib/useMicrophoneTest.js";

interface AudioDeviceSettingsProps {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  inputVolume: number;
  outputVolume: number;
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
  onToggleMicrophoneTest(): Promise<void>;
}

function AudioLevelControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="audio-level-control">
      <span><span>{label}</span><strong>{value}%</strong></span>
      <input aria-label={label} type="range" min="0" max="200" step="1" value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </label>
  );
}

export function AudioDeviceSettings(props: AudioDeviceSettingsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320 });
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
    const height = Math.min(590, window.innerHeight - 16);
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
          <div className="audio-device-fields">
            <label className="form-field">
              <span>{props.labels.microphone}</span>
              <select className="input" name="audioInput" value={props.selectedInputId} onChange={(event) => props.onSelectInput(event.currentTarget.value)}>
                <option value="">{props.labels.systemDefault}</option>
                {props.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{audioDeviceDisplayName(device, props.labels.microphone, index)}</option>)}
              </select>
            </label>
            <AudioLevelControl label={props.labels.inputVolume} value={props.inputVolume} onChange={props.onInputVolumeChange} />
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
            <button className="btn btn-ghost" type="button" disabled={props.loading} onClick={() => void props.onRefresh()}>{props.loading ? `${props.labels.refresh}…` : props.labels.refresh}</button>
            <p className="error-text" aria-live="polite">{deviceStatus || testStatus}</p>
          </div>
        </div>,
        document.body
      ) : null}
    </section>
  );
}
