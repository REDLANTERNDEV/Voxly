/** Capture health deliberately ignores signal energy: silence is valid audio. */
export interface MicrophoneHealthState { faultSince: number | null; warning: boolean }
export interface MicrophoneHealthSample {
  expected: boolean;
  visible: boolean;
  live: boolean;
  unavailable: boolean;
  contextState: string;
  now: number;
}
export const microphoneFaultDebounceMs = 5_000;
export function stepMicrophoneHealth(state: MicrophoneHealthState, sample: MicrophoneHealthSample): MicrophoneHealthState {
  if (!sample.expected || !sample.visible) return { faultSince: null, warning: false };
  if (!sample.live || sample.contextState === "closed") return { faultSince: sample.now, warning: true };
  if (!sample.unavailable && sample.contextState === "running") return { faultSince: null, warning: false };
  const faultSince = state.faultSince ?? sample.now;
  return { faultSince, warning: sample.now - faultSince >= microphoneFaultDebounceMs };
}
