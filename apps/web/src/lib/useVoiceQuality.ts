import { useEffect, useRef, useState } from "react";
import {
  readVoiceCounters,
  readVoiceTransport,
  updateVoiceQualityRecovery,
  voiceQualityReading,
  worstVoiceQuality,
  worstVoiceTransport,
  type VoiceCounters,
  type VoiceQualityGrade,
  type VoiceQualityReading,
  type VoiceQualityRecoveryState,
  type VoiceQualitySymptom,
  type VoiceTransportReading
} from "./voiceQuality.js";

/**
 * Long enough that one late packet does not turn the signal red, short enough
 * that a member who says "it is doing it right now" can still see it.
 */
export const voiceQualitySampleMs = 4_000;

export interface VoiceQuality {
  grade: VoiceQualityGrade;
  symptom: VoiceQualitySymptom;
  reading: VoiceQualityReading | null;
  transport: VoiceTransportReading | null;
}

const measuring: VoiceQuality = { grade: "measuring", symptom: "none", reading: null, transport: null };

/**
 * `RTCStatsReport` is map-like, but the DOM types this project builds against
 * expose only `forEach` on it, so the entries are gathered rather than iterated
 * directly. Doing it here keeps `voiceQuality.ts` taking a plain iterable,
 * which is what lets the grading be tested without a browser.
 */
function collectStats(report: RTCStatsReport) {
  const entries: Record<string, unknown>[] = [];
  report.forEach((entry) => entries.push(entry as Record<string, unknown>));
  return entries;
}

export interface VoiceStatsPeer {
  userId: string;
  peer: RTCPeerConnection;
}

export type VoiceStatsSource = () => Iterable<VoiceStatsPeer>;

export type VoicePeerRecoveryHandler = (userId: string) => void;

/**
 * Samples the receiving decoders while the member is in a voice room.
 *
 * Counters are held per peer connection rather than summed, because the
 * question a member asks is "is it me or is it them", and a summed figure
 * cannot answer it. The map is rebuilt from the live peers on every tick so a
 * peer that leaves takes its counters with it, and a peer that reconnects is
 * measured from its own zero rather than against a predecessor's totals.
 */
export function useVoiceQuality(
  peers: VoiceStatsSource | null,
  onPeerRecoveryNeeded?: VoicePeerRecoveryHandler
): VoiceQuality {
  const [quality, setQuality] = useState<VoiceQuality>(measuring);
  const previousRef = useRef<Map<RTCPeerConnection, VoiceCounters>>(new Map());
  const recoveryRef = useRef<Map<string, VoiceQualityRecoveryState>>(new Map());
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    previousRef.current = new Map();
    recoveryRef.current = new Map();
    if (!peers) {
      setQuality(measuring);
      return;
    }

    const sample = async () => {
      const current = new Map<RTCPeerConnection, VoiceCounters>();
      const currentRecovery = new Map<string, VoiceQualityRecoveryState>();
      const readings: VoiceQualityReading[] = [];
      const transportReadings: VoiceTransportReading[] = [];
      for (const { userId, peer } of peers()) {
        let counters: VoiceCounters;
        try {
          const report = collectStats(await peer.getStats());
          counters = readVoiceCounters(report);
          const transport = readVoiceTransport(report);
          if (transport.candidatePairState) transportReadings.push(transport);
        } catch {
          // A peer closing mid-sample rejects rather than resolving empty. It
          // simply does not contribute this tick.
          continue;
        }
        if (generation !== generationRef.current) return;
        current.set(peer, counters);
        const previous = previousRef.current.get(peer);
        const reading = previous ? voiceQualityReading(previous, counters) : null;
        const recoveryState = recoveryRef.current.get(userId) ?? {
          consecutiveDegradedSamples: 0,
          lastRecoveryAt: null
        };
        if (reading) {
          readings.push(reading);
          const recovery = updateVoiceQualityRecovery(recoveryState, reading, Date.now());
          currentRecovery.set(userId, recovery.state);
          if (recovery.recover) onPeerRecoveryNeeded?.(userId);
        } else {
          currentRecovery.set(userId, { ...recoveryState, consecutiveDegradedSamples: 0 });
        }
      }
      previousRef.current = current;
      recoveryRef.current = currentRecovery;
      const worst = worstVoiceQuality(readings);
      setQuality(worst
        ? { grade: worst.grade, symptom: worst.symptom, reading: worst, transport: worstVoiceTransport(transportReadings) }
        : { ...measuring, transport: worstVoiceTransport(transportReadings) });
    };

    void sample();
    const timer = window.setInterval(() => void sample(), voiceQualitySampleMs);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
    };
  }, [onPeerRecoveryNeeded, peers]);

  return quality;
}
