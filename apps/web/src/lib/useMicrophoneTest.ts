import { useCallback, useEffect, useRef, useState } from "react";
import { buildMicrophoneConstraints } from "./audioDevices.js";
import { createMicrophoneInput, type MicrophoneInput } from "./microphoneInput.js";
import { applyMicrophoneProcessing, DEFAULT_NOISE_SUPPRESSION, microphoneProcessingConstraints } from "./noiseSuppression.js";

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
    inputRef.current?.dispose();
    inputRef.current = null;
    setMonitorStream(null);
    setActive(false);
    setError(null);
    if (sharedStreamRef.current) {
      setMonitorStream(sharedStreamRef.current);
      setActive(true);
      return true;
    }
    let rawStream: MediaStream | null = null;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia(buildMicrophoneConstraints(deviceIdRef.current, microphoneProcessingConstraints(noiseSuppressionRef.current)));
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
    const deviceChanged = deviceIdRef.current !== deviceId;
    const processingChanged = noiseSuppressionRef.current !== noiseSuppression;
    deviceIdRef.current = deviceId;
    noiseSuppressionRef.current = noiseSuppression;
    const input = inputRef.current;
    if (!input || (!deviceChanged && !processingChanged)) return;
    if (deviceChanged) {
      void start();
      return;
    }
    // Reopening the device to change processing makes the echo canceller
    // re-converge, which is plainly audible while monitoring. Reconfigure the
    // live capture instead and only restart where that is unsupported.
    const generation = generationRef.current;
    void applyMicrophoneProcessing(input.rawStream.getAudioTracks()[0], noiseSuppression).then((reconfigured) => {
      if (reconfigured || generation !== generationRef.current || inputRef.current !== input) return;
      void start();
    });
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
