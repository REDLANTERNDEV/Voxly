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
      // Releasing the running capture is what lets the requested processing
      // take on the reopened device, so it is handed to the opener.
      rawStream = await openMicrophoneCapture(
        { deviceId: deviceIdRef.current, noiseSuppression: noiseSuppressionRef.current },
        { release: () => previous?.dispose() }
      );
      const input = createMicrophoneInput(rawStream, volumeRef.current);
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

  // One effect for both capture inputs so a simultaneous device and suppression
  // change restarts a self-owned capture once. A test riding the shared voice
  // monitor has no input of its own and inherits the voice graph instead.
  useEffect(() => {
    const change = microphoneCaptureChange(
      { deviceId: deviceIdRef.current, noiseSuppression: noiseSuppressionRef.current },
      { deviceId, noiseSuppression }
    );
    deviceIdRef.current = deviceId;
    noiseSuppressionRef.current = noiseSuppression;
    if (change === "none" || !inputRef.current) return;
    // Both kinds of change reopen the device. Monitoring is the one place the
    // suppression setting can actually be heard, so it has to reflect the
    // preference rather than whatever the capture happened to open with.
    void start();
  }, [deviceId, noiseSuppression, start]);

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
