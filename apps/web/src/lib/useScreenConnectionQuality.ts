import { useEffect, useState } from "react";
import { stepScreenConnectionWarning, type ScreenConnectionWarningState } from "./screenQuality.js";
import { safeScreenStats, voiceDiagnostics } from "./voiceDiagnostics.js";

export interface ScreenReceiverSource {
  userId: string;
  peer: RTCPeerConnection;
  receiver: RTCRtpReceiver;
}
/** Sample only subscribed screen receivers. A small source is cheaper than every video peer. */
export function useScreenConnectionQuality(source: (() => ScreenReceiverSource[]) | null) {
  const [warnings, setWarnings] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setWarnings({});
    if (!source) return;
    let disposed = false,
      busy = false;
    const previous = new Map<RTCRtpReceiver, { id: unknown; received: number; lost: number }>();
    const streaks = new Map<RTCRtpReceiver, ScreenConnectionWarningState>();
    const sample = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        const snapshot = source();
        const reports = await Promise.all(
          snapshot.map(async (entry) => {
            const report: Record<string, unknown>[] = [];
            try {
              (await entry.receiver.getStats()).forEach((value) => report.push(value as Record<string, unknown>));
            } catch {
              /* Missing statistics do not prove a connection problem. */
            }
            return { ...entry, report };
          })
        );
        if (disposed) return;
        const live = new Set(source().map((entry) => entry.receiver));
        for (const receiver of previous.keys())
          if (!live.has(receiver)) {
            previous.delete(receiver);
            streaks.delete(receiver);
          }
        const next: Record<string, boolean> = {};
        for (const entry of reports) {
          if (!live.has(entry.receiver) || entry.peer.connectionState !== "connected") continue;
          const inbound = entry.report.find(
            (item) => item.type === "inbound-rtp" && (item.kind === "video" || item.mediaType === "video")
          );
          const transport = entry.report.find((item) => item.type === "transport" && item.id === inbound?.transportId);
          const pair = entry.report.find(
            (item) =>
              item.type === "candidate-pair" &&
              (item.id === transport?.selectedCandidatePairId ||
                item.selected === true ||
                (item.nominated === true && item.state === "succeeded"))
          );
          const baseline = previous.get(entry.receiver);
          let loss: number | undefined;
          if (inbound && typeof inbound.packetsReceived === "number" && typeof inbound.packetsLost === "number") {
            const received = inbound.packetsReceived,
              lost = inbound.packetsLost;
            if (baseline && baseline.id === inbound.id && received >= baseline.received) {
              const receivedDelta = received - baseline.received,
                lostDelta = Math.max(0, lost - baseline.lost);
              if (receivedDelta + lostDelta > 0) loss = lostDelta / (receivedDelta + lostDelta);
            }
            previous.set(entry.receiver, { id: inbound.id, received, lost });
          }
          const rttMs =
            typeof pair?.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
              ? pair.currentRoundTripTime * 1000
              : undefined;
          const reading = stepScreenConnectionWarning(
            streaks.get(entry.receiver) ?? { warning: false, bad: 0, healthy: 0 },
            { loss, rttMs }
          );
          streaks.set(entry.receiver, reading);
          next[entry.userId] = Boolean(next[entry.userId]) || reading.warning;
          voiceDiagnostics.record(
            "screen",
            { direction: "receive", video: safeScreenStats(entry.report), loss, rttMs },
            entry.peer
          );
        }
        setWarnings((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
      } finally {
        busy = false;
      }
    };
    void sample();
    const timer = setInterval(() => void sample(), 2_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [source]);
  return warnings;
}
