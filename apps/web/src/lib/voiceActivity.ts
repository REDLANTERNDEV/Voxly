/**
 * Microphone activity detection.
 *
 * Two properties matter more than the exact numbers. Coverage: the sampler must
 * see enough of the signal that a pause between syllables is not mistaken for
 * silence. Sensitivity: the trigger point has to sit just above whatever this
 * room and this microphone actually produce, because a fixed level that suits a
 * loud headset mic never arms for a quiet or distant one.
 */
export const voiceActivitySampleMs = 25;

/**
 * Absolute guard so a muted or disconnected capture cannot arm on numeric
 * noise, no matter how low the measured floor falls.
 */
export const voiceActivityFloorRms = 0.0022;
export const voiceActivityExitFloorRms = voiceActivityFloorRms * 0.6;

/** Speech must clear the measured room noise by this much to arm the gate. */
export const voiceActivityEnterRatio = 2.6;
/** ...and stay above this lower multiple to hold it, which debounces syllables. */
export const voiceActivityExitRatio = 1.6;

export const voiceActivityReleaseMs = 320;

/**
 * The member ring answers "whose microphone is carrying sound?", including a
 * low steady hiss. It deliberately does not adapt that sound away as a noise
 * floor: doing so made an audible background-noise source disappear after it
 * had been present for a while.
 */
export const audibleActivityEnterRms = 0.0008;
export const audibleActivityExitRms = 0.0005;

/**
 * Minimum tracking: the floor drops towards anything quieter within a couple of
 * samples and otherwise creeps up by a fixed fraction per sample. Steady room
 * noise is therefore measured within a second, while speech — which is only
 * ever the loud side of the comparison — can move it no faster than the creep,
 * and every pause pulls it straight back down.
 */
export const voiceActivityFloorFallAlpha = 0.5;
export const voiceActivityFloorCreep = 1.0004;

export interface VoiceActivityState {
  speaking: boolean;
  lastAudibleAt: number;
  noiseFloor: number;
}

export interface AudibleActivityState {
  speaking: boolean;
  lastAudibleAt: number;
}

export function createVoiceActivityState(): VoiceActivityState {
  return { speaking: false, lastAudibleAt: 0, noiseFloor: voiceActivityFloorRms };
}

export function createAudibleActivityState(): AudibleActivityState {
  return { speaking: false, lastAudibleAt: 0 };
}

export function voiceActivityThresholds(noiseFloor: number) {
  return {
    enter: Math.max(voiceActivityFloorRms, noiseFloor * voiceActivityEnterRatio),
    exit: Math.max(voiceActivityExitFloorRms, noiseFloor * voiceActivityExitRatio)
  };
}

function nextNoiseFloor(current: number, rms: number) {
  if (rms < current) return current + (rms - current) * voiceActivityFloorFallAlpha;
  // Never creep past the signal itself, so the floor cannot climb above what
  // the microphone is actually producing.
  return Math.min(current * voiceActivityFloorCreep, rms);
}

export function updateVoiceActivity(state: VoiceActivityState, rms: number, now: number): VoiceActivityState {
  const thresholds = voiceActivityThresholds(state.noiseFloor);
  const noiseFloor = nextNoiseFloor(state.noiseFloor, rms);

  if (!state.speaking) {
    return rms >= thresholds.enter
      ? { speaking: true, lastAudibleAt: now, noiseFloor }
      : { ...state, noiseFloor };
  }

  if (rms >= thresholds.exit) {
    return { speaking: true, lastAudibleAt: now, noiseFloor };
  }

  return now - state.lastAudibleAt >= voiceActivityReleaseMs
    ? { ...state, speaking: false, noiseFloor }
    : { ...state, noiseFloor };
}

export function updateAudibleActivity(state: AudibleActivityState, rms: number, now: number): AudibleActivityState {
  const threshold = state.speaking ? audibleActivityExitRms : audibleActivityEnterRms;
  if (rms >= threshold) return { speaking: true, lastAudibleAt: now };
  return state.speaking && now - state.lastAudibleAt >= voiceActivityReleaseMs
    ? { ...state, speaking: false }
    : state;
}
