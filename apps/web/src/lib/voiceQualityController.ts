import { safeAudioStats, voiceDiagnostics } from "./voiceDiagnostics.js";
import {
  readVoiceCounters, readVoiceTransport, updateVoiceRecoveryEligibility, voiceMediaStalled, voiceQualityNeedsRecovery,
  voiceQualityReading, worstVoiceQuality, worstVoiceTransport,
  type VoiceCounters, type VoiceQualityGrade, type VoiceQualityReading,
  type VoiceQualityRecoveryState, type VoiceQualitySymptom, type VoiceTransportReading
} from "./voiceQuality.js";

export interface VoiceStatsPeer {
  userId: string;
  peer: RTCPeerConnection;
  expectingAudio?: boolean;
  /** Receiver track IDs known to carry microphone audio; screen audio is separate. */
  microphoneTrackIds?: readonly string[];
  /** Only currently receiving transceivers; retired receiver stats may remain. */
  activeAudioTrackIds?: readonly string[];
  recovering?: boolean;
}
export type VoiceStatsSource = () => Iterable<VoiceStatsPeer>;
export interface VoiceQualityRecoveryRequest {
  peerUserId: string;
  requestId: number;
  peer: RTCPeerConnection;
}
export interface VoiceQuality {
  grade: VoiceQualityGrade;
  symptom: VoiceQualitySymptom;
  reading: VoiceQualityReading | null;
  transport: VoiceTransportReading | null;
  recovering?: boolean;
  recoveryRequests: readonly VoiceQualityRecoveryRequest[];
  clearPeers: readonly VoiceStatsPeer[];
}
export function measuringVoiceQuality(): VoiceQuality {
  return { grade: "measuring", symptom: "none", reading: null, transport: null, recoveryRequests: [], clearPeers: [] };
}

function streams(report: readonly Record<string, unknown>[], activeTrackIds?: readonly string[]) {
  const result = new Map<string, { counters: VoiceCounters; trackId: string | null; measurable: boolean }>();
  for (const entry of report) {
    if (entry.type !== "inbound-rtp" || (entry.kind !== "audio" && entry.mediaType !== "audio")) continue;
    // No stable identity means no safe delta. Never manufacture a healthy reading.
    if (typeof entry.id !== "string") continue;
    if (activeTrackIds && (activeTrackIds.length === 0 || (typeof entry.trackIdentifier === "string" && !activeTrackIds.includes(entry.trackIdentifier)))) continue;
    const key = JSON.stringify([entry.id, entry.ssrc, entry.trackIdentifier, entry.codecId]);
    result.set(key, {
      counters: readVoiceCounters([entry]),
      measurable: (activeTrackIds === undefined || typeof entry.trackIdentifier === "string") && ["packetsReceived", "packetsLost", "concealedSamples", "silentConcealedSamples", "jitterBufferEmittedCount", "jitterBufferDelay", "removedSamplesForAcceleration", "insertedSamplesForDeceleration"].every(field => typeof entry[field] === "number" && Number.isFinite(entry[field])),
      trackId: typeof entry.trackIdentifier === "string" ? entry.trackIdentifier : null
    });
  }
  return result;
}

/** A reset is different from packetsLost being revised down by a late packet. */
function reset(previous: VoiceCounters, next: VoiceCounters) {
  return next.packetsReceived < previous.packetsReceived
    || next.jitterBufferEmittedCount < previous.jitterBufferEmittedCount
    || next.concealedSamples < previous.concealedSamples;
}

/** Owns observations only. The media owner executes all recovery requests. */
export class VoiceQualityController {
  private previous = new Map<RTCPeerConnection, ReturnType<typeof streams>>();
  private recovery = new Map<RTCPeerConnection, VoiceQualityRecoveryState>();
  // A connection replacement resets its streak but must not evade the cooldown.
  private cooldown = new Map<string, number>();
  private sequence = 0;
  private busy = false;
  private disposed = false;

  constructor(private readonly source: VoiceStatsSource, private readonly now = Date.now) {}

  dispose() {
    this.disposed = true;
    this.previous.clear();
    this.recovery.clear();
    this.cooldown.clear();
  }

  async sample(): Promise<VoiceQuality | null> {
    if (this.busy || this.disposed) return null;
    this.busy = true;
    try {
      const snapshot = [...this.source()];
      const reports = await Promise.all(snapshot.map(async (entry) => {
        try {
          const report: Record<string, unknown>[] = [];
          (await entry.peer.getStats()).forEach(value => report.push(value as Record<string, unknown>));
          return { ...entry, report };
        } catch { return { ...entry, report: null }; }
      }));
      if (this.disposed) return null;
      const live = new Map([...this.source()].map(entry => [entry.userId, entry]));
      const previous = new Map<RTCPeerConnection, ReturnType<typeof streams>>();
      const recovery = new Map<RTCPeerConnection, VoiceQualityRecoveryState>();
      const readings: VoiceQualityReading[] = [];
      const transports: VoiceTransportReading[] = [];
      const recoveryRequests: VoiceQualityRecoveryRequest[] = [];
      const clearPeers: VoiceStatsPeer[] = [];
      let incomplete = false;
      for (const entry of reports) {
        const current = live.get(entry.userId);
        if (!current || current.peer !== entry.peer) continue;
        const { peer, userId, report } = entry;
        const initial = { consecutiveDegradedSamples: 0, lastRecoveryAt: this.cooldown.get(userId) ?? null };
        if (!report) {
          incomplete = true;
          recovery.set(peer, initial);
          continue;
        }
        const transport = readVoiceTransport(report);
        if (transport.candidatePairState) transports.push(transport);
        voiceDiagnostics.record("sample", {
          connection: peer.connectionState, ice: peer.iceConnectionState,
          signaling: peer.signalingState, expectingAudio: current.expectingAudio === true,
          transport, audio: safeAudioStats(report)
        }, peer);
        const next = streams(report, current.activeAudioTrackIds);
        const before = this.previous.get(peer);
        previous.set(peer, next);
        const peerReadings: VoiceQualityReading[] = [];
        let allMeasured = next.size > 0 && peer.connectionState === "connected";
        // A confirmed receiver with expected speech but no inbound RTP is a
        // stall only when this is a successful connected transport report.
        let stalled = Boolean(before && next.size === 0 && current.expectingAudio
          && current.activeAudioTrackIds?.some(id => current.microphoneTrackIds?.includes(id))
          && peer.connectionState === "connected" && transport.candidatePairState === "succeeded");
        let eligible = false;
        for (const [key, stream] of next) {
          const baseline = before?.get(key);
          const last = baseline?.counters;
          if (!last || !baseline.measurable || !stream.measurable || reset(last, stream.counters)) { allMeasured = false; continue; }
          const expecting = current.expectingAudio === true && (current.microphoneTrackIds === undefined
            || (stream.trackId !== null && current.microphoneTrackIds.includes(stream.trackId)));
          const reading = stream.measurable ? voiceQualityReading(last, stream.counters) : null;
          const stopped = peer.connectionState === "connected" && voiceMediaStalled(last, stream.counters, expecting);
          stalled ||= stopped;
          if (reading) {
            peerReadings.push(reading);
            // Use the same policy for streaks and requests; mild samples never qualify.
            eligible ||= voiceQualityNeedsRecovery(reading, expecting);
          } else { allMeasured = false; }
        }
        const worst = worstVoiceQuality(peerReadings);
        if (worst) readings.push(worst);
        if (stalled && (!worst || worst.grade !== "breaking")) {
          readings.push({ grade: "breaking", symptom: "gaps", lossPercent: 0, concealedMs: 0, spedUpMs: 0, slowedDownMs: 0, bufferMs: worst?.bufferMs ?? 0 });
        }
        incomplete ||= !allMeasured;
        const state = this.recovery.get(peer) ?? initial;
        const transition = updateVoiceRecoveryEligibility(state, peer.connectionState === "connected" && (stalled || eligible), this.now());
        recovery.set(peer, transition.state);
        if (transition.recover) {
          this.cooldown.set(userId, this.now());
          recoveryRequests.push({ peerUserId: userId, peer, requestId: ++this.sequence });
        }
        if (allMeasured && !stalled && worst?.grade === "clear" && peer.connectionState === "connected") clearPeers.push(current);
      }
      // Any newly joined peer whose stats weren't requested is not yet measured.
      incomplete ||= [...live.values()].some(entry => !previous.has(entry.peer));
      this.previous = previous;
      this.recovery = recovery;
      for (const id of this.cooldown.keys()) if (!live.has(id)) this.cooldown.delete(id);
      const worst = worstVoiceQuality(readings);
      const reading = worst?.grade === "clear" && incomplete ? null : worst;
      return {
        ...measuringVoiceQuality(), grade: reading?.grade ?? "measuring", symptom: reading?.symptom ?? "none",
        reading, transport: worstVoiceTransport(transports),
        recovering: [...live.values()].some(entry => entry.recovering), recoveryRequests, clearPeers
      };
    } finally { this.busy = false; }
  }
}
