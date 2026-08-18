import {
  createVoiceActivityState,
  updateVoiceActivity,
  type VoiceActivityState
} from "./voiceActivity.js";

/**
 * Suppression that the application performs itself, in the capture graph.
 *
 * The browser constraint alone is not a control we can offer: Chrome runs one
 * audio processing module for a capture, echo cancellation engages it, and
 * `noiseSuppression: false` does not reliably disengage the suppressor inside
 * it. The constraint also cannot be changed on a live track, so honouring it
 * meant releasing and reopening the device on every toggle. A stage we own
 * responds on the next audio block and is audible on every browser.
 *
 * The stage is a high-pass followed by a downward expander driven by the same
 * adaptive floor the speaking indicator uses, so what the gate considers speech
 * and what the ring shows can never disagree.
 */

/**
 * Residual gain while the gate is closed. Ducking to a floor rather than to
 * silence is the difference between suppression you stop noticing and one that
 * chops the room in and out around every word.
 */
export const noiseGateClosedGain = 0.05;
export const noiseGateOpenGain = 1;

/**
 * Opening has to beat the speech that triggered it, or the gate eats the
 * consonant that opened it. Closing is slow enough not to pump between words.
 */
export const noiseGateAttackSeconds = 0.01;
export const noiseGateReleaseSeconds = 0.12;

/** Voice carries nothing below this; rumble, handling noise, and fans do. */
export const noiseGateHighPassHz = 90;
export const noiseGateHighPassQ = 0.7;
/** Below the audible band, so the filter is inaudible when the stage is off. */
export const noiseGateBypassHz = 10;

export interface NoiseGateState {
  activity: VoiceActivityState;
  open: boolean;
}

export function createNoiseGateState(): NoiseGateState {
  // Opens first and closes once the floor is measured, so the first syllable
  // after joining is never the one the gate learns on.
  return { activity: createVoiceActivityState(), open: true };
}

export function stepNoiseGate(state: NoiseGateState, rms: number, now: number): NoiseGateState {
  const activity = updateVoiceActivity(state.activity, rms, now);
  return { activity, open: activity.speaking };
}

export function noiseGateGain(open: boolean) {
  return open ? noiseGateOpenGain : noiseGateClosedGain;
}

export function noiseGateTimeConstant(open: boolean) {
  return open ? noiseGateAttackSeconds : noiseGateReleaseSeconds;
}

export function noiseGateHighPassFrequency(enabled: boolean) {
  return enabled ? noiseGateHighPassHz : noiseGateBypassHz;
}

/**
 * With the stage off the expander is held wide open rather than unwired, so the
 * preference never changes the shape of the graph — only the values on it.
 */
export function noiseGateTargetGain(enabled: boolean, open: boolean) {
  return enabled ? noiseGateGain(open) : noiseGateOpenGain;
}
