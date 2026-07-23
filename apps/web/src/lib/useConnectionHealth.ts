import { useCallback, useEffect, useRef, useState } from "react";
import type { VoxlySocket } from "../socket.js";
import { connectionQualityForRtt, medianRtt, type ConnectionQuality } from "./connectionHealth.js";

export type ConnectionFailureReason = "browser_offline" | "server_unreachable";

export interface ConnectionHealth {
  quality: ConnectionQuality;
  rttMs: number | null;
  overlayVisible: boolean;
  reconnectAttempt: number;
  reason: ConnectionFailureReason;
}

const probeIntervalMs = 5_000;
const probeTimeoutMs = 2_500;
const reconnectOverlayDelayMs = 3_000;

export function useConnectionHealth(socket: VoxlySocket | null): ConnectionHealth {
  const [health, setHealth] = useState<ConnectionHealth>({
    quality: "measuring",
    rttMs: null,
    overlayVisible: false,
    reconnectAttempt: 0,
    reason: "server_unreachable"
  });
  const samplesRef = useRef<number[]>([]);
  const probeInFlightRef = useRef(false);
  const probeTimeoutRef = useRef<number | null>(null);
  const overlayTimerRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const probeIdRef = useRef(0);

  const clearProbeTimeout = useCallback(() => {
    if (probeTimeoutRef.current !== null) window.clearTimeout(probeTimeoutRef.current);
    probeTimeoutRef.current = null;
  }, []);

  const probe = useCallback(() => {
    if (!socket?.connected || probeInFlightRef.current) return;
    const generation = generationRef.current;
    const probeId = ++probeIdRef.current;
    const startedAt = performance.now();
    probeInFlightRef.current = true;
    clearProbeTimeout();
    probeTimeoutRef.current = window.setTimeout(() => {
      if (generation !== generationRef.current || probeId !== probeIdRef.current) return;
      probeInFlightRef.current = false;
      probeTimeoutRef.current = null;
      probeIdRef.current += 1;
      setHealth((current) => ({ ...current, quality: "poor", reason: navigator.onLine ? "server_unreachable" : "browser_offline" }));
    }, probeTimeoutMs);
    socket.emit("connection:probe", () => {
      if (generation !== generationRef.current || probeId !== probeIdRef.current) return;
      clearProbeTimeout();
      probeInFlightRef.current = false;
      const sample = Math.max(0, Math.round(performance.now() - startedAt));
      samplesRef.current = [...samplesRef.current, sample].slice(-5);
      const rttMs = medianRtt(samplesRef.current);
      setHealth((current) => ({
        ...current,
        quality: connectionQualityForRtt(rttMs),
        rttMs,
        overlayVisible: false,
        reconnectAttempt: 0,
        reason: "server_unreachable"
      }));
    });
  }, [clearProbeTimeout, socket]);

  useEffect(() => {
    if (!socket) return;
    const clearOverlayTimer = () => {
      if (overlayTimerRef.current !== null) window.clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = null;
    };
    const scheduleOverlay = () => {
      clearOverlayTimer();
      overlayTimerRef.current = window.setTimeout(() => {
        setHealth((current) => ({
          ...current,
          overlayVisible: true,
          reason: navigator.onLine ? "server_unreachable" : "browser_offline"
        }));
      }, reconnectOverlayDelayMs);
    };
    const onConnect = () => {
      generationRef.current += 1;
      probeIdRef.current += 1;
      probeInFlightRef.current = false;
      clearProbeTimeout();
      clearOverlayTimer();
      setHealth((current) => ({ ...current, quality: "measuring" }));
      probe();
    };
    const onDisconnect = () => {
      generationRef.current += 1;
      probeIdRef.current += 1;
      probeInFlightRef.current = false;
      clearProbeTimeout();
      setHealth((current) => ({
        ...current,
        quality: "poor",
        reason: navigator.onLine ? "server_unreachable" : "browser_offline"
      }));
      scheduleOverlay();
    };
    const onReconnectAttempt = (attempt: number) => {
      setHealth((current) => ({ ...current, quality: "poor", reconnectAttempt: attempt }));
    };
    const onNetworkChange = () => {
      setHealth((current) => ({ ...current, reason: navigator.onLine ? "server_unreachable" : "browser_offline" }));
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.io.on("reconnect_attempt", onReconnectAttempt);
    window.addEventListener("online", onNetworkChange);
    window.addEventListener("offline", onNetworkChange);
    const interval = window.setInterval(probe, probeIntervalMs);
    if (socket.connected) onConnect();
    else onDisconnect();

    return () => {
      generationRef.current += 1;
      probeIdRef.current += 1;
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
      window.removeEventListener("online", onNetworkChange);
      window.removeEventListener("offline", onNetworkChange);
      window.clearInterval(interval);
      clearOverlayTimer();
      clearProbeTimeout();
      probeInFlightRef.current = false;
    };
  }, [clearProbeTimeout, probe, socket]);

  return health;
}
