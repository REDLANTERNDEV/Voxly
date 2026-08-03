export type AudioDevicePreferenceKind = "input" | "output";

export interface AudioDeviceStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface AudioDeviceCollection {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

interface AudioDeviceDiscovery {
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

interface AudioDeviceChangeSource {
  addEventListener(type: "devicechange", listener: () => void): void;
  removeEventListener(type: "devicechange", listener: () => void): void;
}

interface SinkTarget {
  setSinkId?(sinkId: string): Promise<unknown>;
}

export interface AudioOutputTargets {
  audioContext?: SinkTarget | null;
  mediaElements?: readonly SinkTarget[];
}

export type AudioOutputApplication = "audio-context" | "media-elements" | "unsupported";

export interface MicrophoneCaptureOptions {
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export function audioDevicePreferenceKey(userId: string, kind: AudioDevicePreferenceKind) {
  return `voxly:audio-device:${userId}:${kind}`;
}

export function readAudioDevicePreference(
  storage: AudioDeviceStorage,
  userId: string,
  kind: AudioDevicePreferenceKind
) {
  return storage.getItem(audioDevicePreferenceKey(userId, kind)) ?? "";
}

export function writeAudioDevicePreference(
  storage: AudioDeviceStorage,
  userId: string,
  kind: AudioDevicePreferenceKind,
  deviceId: string
) {
  const key = audioDevicePreferenceKey(userId, kind);
  if (!deviceId) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, deviceId);
}

export async function enumerateAudioDevices(
  mediaDevices: AudioDeviceDiscovery,
  options: { requestPermission?: boolean } = {}
): Promise<AudioDeviceCollection> {
  if (options.requestPermission) {
    if (!mediaDevices.getUserMedia) {
      throw new Error("Microphone access is unavailable in this browser.");
    }
    const permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false });
    permissionStream.getTracks().forEach((track) => track.stop());
  }

  const devices = await mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((entry) => entry.kind === "audioinput"),
    outputs: devices.filter((entry) => entry.kind === "audiooutput")
  };
}

export function reconcileAudioDevicePreference(deviceId: string, devices: readonly MediaDeviceInfo[]) {
  if (!deviceId || devices.some((device) => device.deviceId === deviceId)) {
    return deviceId;
  }
  return "";
}

export function audioDeviceDisplayName(device: Pick<MediaDeviceInfo, "label">, fallbackLabel: string, index: number) {
  return device.label.trim() || `${fallbackLabel} ${index + 1}`;
}

export function subscribeToAudioDeviceChanges(
  mediaDevices: AudioDeviceChangeSource,
  onDeviceChange: () => void
) {
  mediaDevices.addEventListener("devicechange", onDeviceChange);
  return () => mediaDevices.removeEventListener("devicechange", onDeviceChange);
}

// Processing flags are requested as plain booleans so they stay ideal
// constraints; an `exact` form could reject the capture on a device that cannot
// honour them. Echo cancellation is deliberately never set here: leaving it to
// the browser default keeps speaker users from hearing themselves back.
export function buildMicrophoneConstraints(
  deviceId: string,
  options: MicrophoneCaptureOptions = {}
): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {};
  if (deviceId) audio.deviceId = { exact: deviceId };
  if (options.noiseSuppression !== undefined) audio.noiseSuppression = options.noiseSuppression;
  if (options.autoGainControl !== undefined) audio.autoGainControl = options.autoGainControl;
  return {
    audio: Object.keys(audio).length > 0 ? audio : true,
    video: false
  };
}

export function supportsAudioOutputSelection(targets: AudioOutputTargets) {
  return typeof targets.audioContext?.setSinkId === "function"
    || targets.mediaElements?.some((element) => typeof element.setSinkId === "function") === true;
}

export async function applyAudioOutputDevice(
  deviceId: string,
  targets: AudioOutputTargets
): Promise<AudioOutputApplication> {
  let audioContextError: unknown;
  if (typeof targets.audioContext?.setSinkId === "function") {
    try {
      await targets.audioContext.setSinkId(deviceId);
      return "audio-context";
    } catch (cause) {
      audioContextError = cause;
    }
  }

  const elements = targets.mediaElements?.filter(
    (element): element is Required<Pick<SinkTarget, "setSinkId">> => typeof element.setSinkId === "function"
  ) ?? [];
  if (elements.length === 0) {
    if (audioContextError) throw audioContextError;
    return "unsupported";
  }

  await Promise.all(elements.map((element) => element.setSinkId(deviceId)));
  return "media-elements";
}
