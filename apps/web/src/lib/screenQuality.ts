export type ScreenQualityProfile = "low" | "startup" | "high";
export const screenQualityProfiles = {
  low: { scaleResolutionDownBy: 2, maxFramerate: 15, maxBitrate: 700_000 },
  startup: { scaleResolutionDownBy: 1, maxFramerate: 15, maxBitrate: 1_400_000 },
  high: { scaleResolutionDownBy: 1, maxFramerate: 30, maxBitrate: 3_000_000 }
} as const;
export interface ScreenQualitySample { loss?: number; rttMs?: number; availableBitrate?: number; bandwidthLimited?: boolean; }
export interface ScreenQualityState {
  profile: ScreenQualityProfile; samples: number; congestion: number; healthy: number; bandwidth: number; reduced: boolean;
}
export function initialScreenQuality(): ScreenQualityState {
  return { profile: "startup", samples: 0, congestion: 0, healthy: 0, bandwidth: 0, reduced: false };
}
const levels: ScreenQualityProfile[] = ["low", "startup", "high"];
export function stepScreenQuality(state: ScreenQualityState, sample: ScreenQualitySample): ScreenQualityState {
  const next = { ...state, samples: state.samples + 1, bandwidth: sample.bandwidthLimited ? state.bandwidth + 1 : 0 };
  const index = levels.indexOf(state.profile);
  const hard = (sample.loss ?? 0) >= 0.12 || (sample.rttMs ?? 0) >= 500;
  const congested = hard || (sample.loss ?? 0) >= 0.05 || (sample.rttMs ?? 0) >= 300
    || (sample.availableBitrate !== undefined && sample.availableBitrate < screenQualityProfiles[state.profile].maxBitrate * 0.8)
    || (next.bandwidth >= 2 && !(state.profile === "startup" && next.samples === 1));
  const capacity = index === 2 || sample.availableBitrate === undefined || sample.availableBitrate >= screenQualityProfiles[levels[index + 1]].maxBitrate * 0.8;
  const healthy = !congested && (sample.loss ?? 0) <= 0.02 && (sample.rttMs ?? 0) <= 200 && capacity;
  next.congestion = congested ? state.congestion + 1 : 0;
  // Initial promotion requires non-congestion, recovery requires stronger evidence.
  next.healthy = (state.reduced ? healthy : !congested && capacity) ? state.healthy + 1 : 0;
  if ((hard || next.congestion >= 2) && index > 0) { next.profile = levels[index - 1]; next.reduced = true; }
  else if (next.healthy >= (state.reduced ? 3 : 2) && index < 2) next.profile = levels[index + 1];
  if (next.profile !== state.profile) { next.congestion = 0; next.healthy = 0; next.bandwidth = 0; }
  return next;
}

/** Report is scoped by RTCRtpSender.getStats(), then linked by remoteId/transportId. */
export function screenSenderSample(report: readonly Record<string, unknown>[]): ScreenQualitySample | null {
  const outbound = report.find(entry => entry.type === "outbound-rtp" && (entry.kind === "video" || entry.mediaType === "video"));
  if (!outbound) return null;
  const remote = report.find(entry => entry.id === outbound.remoteId && entry.type === "remote-inbound-rtp");
  const transport = report.find(entry => entry.id === outbound.transportId && entry.type === "transport");
  const pair = report.find(entry => entry.type === "candidate-pair" && (entry.id === transport?.selectedCandidatePairId || entry.selected === true || (entry.nominated === true && entry.state === "succeeded")));
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const rtt = number(remote?.roundTripTime) ?? number(pair?.currentRoundTripTime);
  return { loss: number(remote?.fractionLost), rttMs: rtt === undefined ? undefined : rtt * 1000,
    availableBitrate: number(pair?.availableOutgoingBitrate), bandwidthLimited: outbound.qualityLimitationReason === "bandwidth" };
}
export interface ScreenConnectionWarningState { warning: boolean; bad: number; healthy: number; }
export function stepScreenConnectionWarning(state: ScreenConnectionWarningState, sample: Pick<ScreenQualitySample, "loss" | "rttMs"> | null): ScreenConnectionWarningState {
  if (!sample || (sample.loss === undefined && sample.rttMs === undefined)) return { ...state, bad: 0, healthy: 0 };
  const bad = (sample.loss ?? 0) >= 0.05 || (sample.rttMs ?? 0) >= 300;
  const next = { warning: state.warning, bad: bad ? state.bad + 1 : 0, healthy: bad ? 0 : state.healthy + 1 };
  if (next.bad >= 2) next.warning = true;
  if (next.healthy >= 3) next.warning = false;
  return next;
}
