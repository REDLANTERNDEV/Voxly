import { useCallback, useEffect, useRef, useState } from "react";
import { createMicrophoneInput, type MicrophoneInput } from "./microphoneInput.js";
import { DEFAULT_NOISE_SUPPRESSION, microphoneCaptureChange, openMicrophoneCapture } from "./noiseSuppression.js";

export type MicrophoneTestError = "permission" | "unavailable" | null;

export function useMicrophoneTest(
  deviceId: string,
  volume: number,
  sharedMonitorStream: MediaStream | null = null,
  noiseSuppression = DEFAULT_NOISE_SUPPRESSION
) {
  const [active, setActive] = useState(false);
  const [monitorStream, setMonitorStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<MicrophoneTestError>(null);
  const inputRef = useRef<MicrophoneInput | null>(null);
  const sharedStreamRef = useRef(sharedMonitorStream);
  const deviceIdRef = useRef(deviceId);
  const noiseSuppressionRef = useRef(noiseSuppression);
  const volumeRef = useRef(volume);
  const generationRef = useRef(0);
  const stopRef = useRef<() => void>(() => undefined);

  const stop = useCallback(() => {
    generationRef.current += 1;
    inputRef.current?.dispose();
    inputRef.current = null;
    setMonitorStream(null);
    setActive(false);
  }, []);
  stopRef.current = stop;

  const start = useCallback(async () => {
    const generation = ++generationRef.current;
    const previous = inputRef.current;
    inputRef.current = null;
    setMonitorStream(null);
    setActive(false);
    setError(null);
    if (sharedStreamRef.current) {
      previous?.dispose();
      setMonitorStream(sharedStreamRef.current);
      setActive(true);
      return true;
    }
    let rawStream: MediaStream | null = null;
    try {
      // The running capture is released first so the reopen is served by a new
      // pipeline rather than the one already attached to the device.
      rawStream = await openMicrophoneCapture(
        { deviceId: deviceIdRef.current },
        { release: () => previous?.dispose() }
      );
      const input = createMicrophoneInput(rawStream, volumeRef.current, {
        noiseSuppression: noiseSuppressionRef.current
      });
      if (generation !== generationRef.current) {
        input.dispose();
        return false;
      }
      inputRef.current = input;
      setMonitorStream(input.monitorStream);
      setActive(true);
      return true;
    } catch (cause) {
      rawStream?.getTracks().forEach((track) => track.stop());
      if (generation === generationRef.current) {
        setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "permission" : "unavailable");
      }
      return false;
    }
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
    inputRef.current?.setVolume(volume);
  }, [volume]);

  // Suppression is a value on the monitor's own graph, so the preference is
  // audible immediately and only a device change reopens the capture. A test
  // riding the shared voice monitor has no input of its own and inherits the
  // voice graph, including its suppression stage.
  useEffect(() => {
    noiseSuppressionRef.current = noiseSuppression;
    inputRef.current?.setNoiseSuppression(noiseSuppression);
  }, [noiseSuppression]);

  useEffect(() => {
    const change = microphoneCaptureChange({ deviceId: deviceIdRef.current }, { deviceId });
    deviceIdRef.current = deviceId;
    if (change === "none" || !inputRef.current) return;
    void start();
  }, [deviceId, start]);

  useEffect(() => {
    const previousSharedStream = sharedStreamRef.current;
    sharedStreamRef.current = sharedMonitorStream;
    if (!active) return;
    if (sharedMonitorStream) {
      generationRef.current += 1;
      inputRef.current?.dispose();
      inputRef.current = null;
      setMonitorStream(sharedMonitorStream);
      setError(null);
    } else if (previousSharedStream) {
      void start();
    }
  }, [active, sharedMonitorStream, start]);

  useEffect(() => {
    return () => {
      stopRef.current();
    };
  }, []);

  return { active, error, monitorStream, start, stop };
}
