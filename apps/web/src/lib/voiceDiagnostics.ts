/** Bounded, memory-only measurements. Never store audio, SDP, ICE addresses or identities. */
const audioFields = [
  "packetsReceived", "packetsSent", "packetsLost", "bytesReceived", "bytesSent", "jitter",
  "concealedSamples", "silentConcealedSamples", "concealmentEvents", "totalSamplesReceived",
  "jitterBufferDelay", "jitterBufferEmittedCount", "jitterBufferTargetDelay",
  "insertedSamplesForDeceleration", "removedSamplesForAcceleration",
  "audioLevel", "totalAudioEnergy", "totalSamplesDuration", "roundTripTime"
] as const;

type Measurement = { atMs: number; event: string; peer?: number; data: unknown };
type Call = { startedAt: string; start: number; startup: Measurement[]; recent: Measurement[] };

export function safeAudioStats(entries: readonly Record<string, unknown>[]) {
  const audioTypes = new Set(["inbound-rtp", "outbound-rtp", "remote-inbound-rtp", "media-source"]);
  const audio = entries.filter(entry => audioTypes.has(String(entry.type)) && (entry.kind === "audio" || entry.mediaType === "audio"));
  return audio.map(entry => {
    const sample: Record<string, number | string> = { type: String(entry.type) };
    for (const field of audioFields) {
      const value = entry[field];
      if (typeof value === "number" && Number.isFinite(value)) sample[field] = value;
    }
    return sample;
  });
}

export class VoiceDiagnostics {
  private calls: Call[] = [];
  private active: Call | null = null;
  private peers = new WeakMap<object, number>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  begin() {
    const start = this.now();
    this.active = { startedAt: new Date(start).toISOString(), start, startup: [], recent: [] };
    this.calls.push(this.active);
    if (this.calls.length > 3) this.calls.shift();
  }

  end() {
    this.record("leave", null);
    this.active = null;
  }

  clear() {
    this.calls = [];
    this.active = null;
    this.peers = new WeakMap();
    this.sequence = 0;
  }

  record(event: "sample" | "input-output" | "recovery" | "leave" | "screen", data: unknown, peer?: object) {
    if (!this.active) return;
    let peerNumber: number | undefined;
    if (peer) {
      if (!this.peers.has(peer)) this.peers.set(peer, ++this.sequence);
      peerNumber = this.peers.get(peer);
    }
    const sample = { atMs: this.now() - this.active.start, event, peer: peerNumber, data };
    // Preserve the initial minute even after hours of talking. Also retain the
    // latest bounded window so a later failure can be compared with startup.
    if (sample.atMs < 60_000 && this.active.startup.length < 200) this.active.startup.push(sample);
    else {
      this.active.recent.push(sample);
      if (this.active.recent.length > 300) this.active.recent.shift();
    }
  }

  report() {
    return { version: 1, calls: this.calls.map(call => ({ startedAt: call.startedAt, samples: [...call.startup, ...call.recent] })) };
  }
}

export const voiceDiagnostics = new VoiceDiagnostics();

declare global { interface Window { __VOXLY_DESKTOP_DIAGNOSTICS_V1__?: {
  version: 1; save(report: string): Promise<"saved" | "cancelled">;
} } }

export async function downloadVoiceDiagnostics() {
  const report = JSON.stringify(voiceDiagnostics.report(), null, 2);
  const native = window.__VOXLY_DESKTOP_DIAGNOSTICS_V1__;
  if (native?.version === 1) {
    const result = await native.save(report);
    if (result !== "saved" && result !== "cancelled") throw new Error("save_failed");
    return;
  }
  if (window.__VOXLY_DESKTOP_V1__?.version === 1) throw new Error("save_unavailable");
  const blob = new Blob([report], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "voxly-voice-diagnostics.json";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Explicit allowlist: no SDP, track/stream identity, candidate address, or content. */
export function safeScreenStats(entries: readonly Record<string, unknown>[]) {
  const fields = ["frameWidth", "frameHeight", "framesPerSecond", "framesEncoded", "framesDecoded", "bytesSent", "bytesReceived", "packetsSent", "packetsReceived", "packetsLost", "roundTripTime", "fractionLost", "timestamp"];
  return entries.filter(entry => ["inbound-rtp", "outbound-rtp", "remote-inbound-rtp"].includes(String(entry.type)) && (entry.kind === "video" || entry.mediaType === "video")).map(entry => {
    const sample: Record<string, number | string> = { type: String(entry.type) };
    for (const field of fields) if (typeof entry[field] === "number" && Number.isFinite(entry[field])) sample[field] = entry[field] as number;
    if (["none", "cpu", "bandwidth", "other"].includes(String(entry.qualityLimitationReason))) sample.qualityLimitationReason = String(entry.qualityLimitationReason);
    return sample;
  });
}
