import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioErrorKey } from "./i18n.js";
import {
  enumerateAudioDevices,
  readAudioDevicePreference,
  reconcileAudioDevicePreference,
  subscribeToAudioDeviceChanges,
  writeAudioDevicePreference,
  type AudioDeviceCollection,
  type AudioDevicePreferenceKind,
  type AudioDeviceStorage
} from "./audioDevices.js";
import {
  selectSharedAudioOutputDevice,
  sharedAudioOutputSelectionSupported
} from "./audioOutput.js";

export interface UseAudioDevicesOptions {
  userId: string | null | undefined;
  mediaDevices?: MediaDevices | null;
  storage?: AudioDeviceStorage | null;
}

export interface UseAudioDevicesResult extends AudioDeviceCollection {
  selectedInputId: string;
  selectedOutputId: string;
  loading: boolean;
  error: AudioErrorKey | "";
  unavailableSelections: AudioDevicePreferenceKind[];
  outputSelectionSupported: boolean;
  refresh(requestPermission?: boolean): Promise<AudioDeviceCollection>;
  selectInput(deviceId: string): void;
  selectOutput(deviceId: string, mediaElements?: readonly HTMLMediaElement[]): Promise<void>;
}

const emptyDevices: AudioDeviceCollection = { inputs: [], outputs: [] };

function defaultMediaDevices() {
  return typeof navigator === "undefined" ? null : navigator.mediaDevices;
}

function defaultStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useAudioDevices({
  userId,
  mediaDevices = defaultMediaDevices(),
  storage = defaultStorage()
}: UseAudioDevicesOptions): UseAudioDevicesResult {
  const [devices, setDevices] = useState<AudioDeviceCollection>(emptyDevices);
  const [selectedInputId, setSelectedInputId] = useState("");
  const [selectedOutputId, setSelectedOutputId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AudioErrorKey | "">("");
  const [unavailableSelections, setUnavailableSelections] = useState<AudioDevicePreferenceKind[]>([]);
  const selectedInputRef = useRef("");
  const selectedOutputRef = useRef("");
  const outputSelectionRequestRef = useRef(0);

  useEffect(() => {
    const nextInput = userId && storage ? readAudioDevicePreference(storage, userId, "input") : "";
    const nextOutput = userId && storage ? readAudioDevicePreference(storage, userId, "output") : "";
    selectedInputRef.current = nextInput;
    selectedOutputRef.current = nextOutput;
    setSelectedInputId(nextInput);
    setSelectedOutputId(nextOutput);
    setUnavailableSelections([]);
    setError("");
    const requestId = ++outputSelectionRequestRef.current;
    void selectSharedAudioOutputDevice(nextOutput).catch(() => {
      if (requestId === outputSelectionRequestRef.current) {
        setError("audioError.outputRestore");
      }
    });
  }, [storage, userId]);

  const refresh = useCallback(async (requestPermission = false) => {
    if (!mediaDevices) {
      setDevices(emptyDevices);
      setError("audioError.unavailable");
      return emptyDevices;
    }

    setLoading(true);
    setError("");
    try {
      const nextDevices = await enumerateAudioDevices(mediaDevices, { requestPermission });
      const nextInput = reconcileAudioDevicePreference(selectedInputRef.current, nextDevices.inputs);
      const nextOutput = reconcileAudioDevicePreference(selectedOutputRef.current, nextDevices.outputs);
      const unavailable: AudioDevicePreferenceKind[] = [];
      if (selectedInputRef.current && !nextInput) unavailable.push("input");
      if (selectedOutputRef.current && !nextOutput) unavailable.push("output");

      selectedInputRef.current = nextInput;
      selectedOutputRef.current = nextOutput;
      setSelectedInputId(nextInput);
      setSelectedOutputId(nextOutput);
      setUnavailableSelections(unavailable);
      setDevices(nextDevices);

      if (userId && storage) {
        if (unavailable.includes("input")) writeAudioDevicePreference(storage, userId, "input", "");
        if (unavailable.includes("output")) writeAudioDevicePreference(storage, userId, "output", "");
      }
      if (unavailable.includes("output")) {
        await selectSharedAudioOutputDevice("");
      }
      return nextDevices;
    } catch (cause) {
      setError("audioError.load");
      throw cause;
    } finally {
      setLoading(false);
    }
  }, [mediaDevices, storage, userId]);

  useEffect(() => {
    if (!mediaDevices) return;
    void refresh(false).catch(() => undefined);
    return subscribeToAudioDeviceChanges(mediaDevices, () => {
      void refresh(false).catch(() => undefined);
    });
  }, [mediaDevices, refresh]);

  const selectInput = useCallback((deviceId: string) => {
    selectedInputRef.current = deviceId;
    setSelectedInputId(deviceId);
    setUnavailableSelections((current) => current.filter((kind) => kind !== "input"));
    if (userId && storage) writeAudioDevicePreference(storage, userId, "input", deviceId);
  }, [storage, userId]);

  const selectOutput = useCallback(async (deviceId: string, mediaElements: readonly HTMLMediaElement[] = []) => {
    const requestId = ++outputSelectionRequestRef.current;
    setError("");
    try {
      await selectSharedAudioOutputDevice(deviceId, mediaElements);
      if (requestId !== outputSelectionRequestRef.current) return;
      selectedOutputRef.current = deviceId;
      setSelectedOutputId(deviceId);
      setUnavailableSelections((current) => current.filter((kind) => kind !== "output"));
      if (userId && storage) writeAudioDevicePreference(storage, userId, "output", deviceId);
    } catch (cause) {
      if (requestId !== outputSelectionRequestRef.current) return;
      setError("audioError.outputChange");
      throw cause;
    }
  }, [storage, userId]);

  return {
    ...devices,
    selectedInputId,
    selectedOutputId,
    loading,
    error,
    unavailableSelections,
    outputSelectionSupported: sharedAudioOutputSelectionSupported(),
    refresh,
    selectInput,
    selectOutput
  };
}
