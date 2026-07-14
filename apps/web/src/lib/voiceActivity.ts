export const voiceActivitySampleMs = 100;
export const voiceActivityEnterRms = 0.012;
export const voiceActivityExitRms = 0.008;
export const voiceActivityReleaseMs = 350;

export interface VoiceActivityState {
  speaking: boolean;
  lastAudibleAt: number;
}

export function createVoiceActivityState(): VoiceActivityState {
  return { speaking: false, lastAudibleAt: 0 };
}

export function updateVoiceActivity(state: VoiceActivityState, rms: number, now: number): VoiceActivityState {
  if (!state.speaking) {
    return rms >= voiceActivityEnterRms
      ? { speaking: true, lastAudibleAt: now }
      : state;
  }

  if (rms >= voiceActivityExitRms) {
    return { speaking: true, lastAudibleAt: now };
  }

  return now - state.lastAudibleAt >= voiceActivityReleaseMs
    ? { ...state, speaking: false }
    : state;
}
