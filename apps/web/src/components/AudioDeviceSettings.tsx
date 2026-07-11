import { audioDeviceDisplayName, type AudioDevicePreferenceKind } from "../lib/audioDevices.js";

interface AudioDeviceSettingsProps {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  loading: boolean;
  error: string;
  unavailableSelections: AudioDevicePreferenceKind[];
  outputSelectionSupported: boolean;
  labels: {
    title: string;
    microphone: string;
    output: string;
    systemDefault: string;
    browserControlled: string;
    refresh: string;
    unavailable: string;
  };
  onOpen(): Promise<unknown>;
  onRefresh(): Promise<unknown>;
  onSelectInput(deviceId: string): void;
  onSelectOutput(deviceId: string): Promise<void>;
}

export function AudioDeviceSettings(props: AudioDeviceSettingsProps) {
  const status = props.error || (props.unavailableSelections.length > 0 ? props.labels.unavailable : "");
  return (
    <details className="audio-device-card" onToggle={(event) => {
      if (event.currentTarget.open) void props.onOpen().catch(() => undefined);
    }}>
      <summary><span>{props.labels.title}</span><span aria-hidden="true">+</span></summary>
      <div className="audio-device-fields">
        <label className="form-field">
          <span>{props.labels.microphone}</span>
          <select className="input" name="audioInput" value={props.selectedInputId} onChange={(event) => props.onSelectInput(event.currentTarget.value)}>
            <option value="">{props.labels.systemDefault}</option>
            {props.inputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{audioDeviceDisplayName(device, props.labels.microphone, index)}</option>)}
          </select>
        </label>
        <label className="form-field">
          <span>{props.labels.output}</span>
          <select className="input" name="audioOutput" value={props.selectedOutputId} disabled={!props.outputSelectionSupported} onChange={(event) => void props.onSelectOutput(event.currentTarget.value).catch(() => undefined)}>
            <option value="">{props.outputSelectionSupported ? props.labels.systemDefault : props.labels.browserControlled}</option>
            {props.outputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{audioDeviceDisplayName(device, props.labels.output, index)}</option>)}
          </select>
        </label>
        <button className="btn btn-ghost" type="button" disabled={props.loading} onClick={() => void props.onRefresh()}>{props.loading ? `${props.labels.refresh}…` : props.labels.refresh}</button>
        <p className="error-text" aria-live="polite">{status}</p>
      </div>
    </details>
  );
}
