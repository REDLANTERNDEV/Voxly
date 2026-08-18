/**
 * Spectral noise suppression for the microphone capture graph.
 *
 * A noise gate attenuates the whole signal while you are not speaking and does
 * nothing while you are, so steady noise stays in every word — which is exactly
 * the noise people want removed. This processor works per frequency band
 * instead: it estimates the noise spectrum continuously, and attenuates each
 * band in proportion to how far it sits above that estimate. Bands carrying
 * speech pass; bands carrying only the fan, the hiss, or the room are pushed
 * down, whether or not anybody is talking.
 *
 * The method is short-time spectral attenuation: STFT, per-bin minimum-statistics
 * noise tracking, a Wiener-style gain with over-subtraction, and overlap-add
 * resynthesis. The gain is smoothed across both time and frequency because an
 * unsmoothed spectral gain produces "musical noise" — isolated bins switching on
 * and off, which sounds worse than the noise it removed.
 *
 * This file is loaded by URL into an AudioWorklet realm, so it is deliberately
 * self-contained: it imports nothing and is served as a static asset.
 */

/** STFT frame size. 512 at 48 kHz is ~10.7 ms — long enough to resolve voice
 *  formants, short enough that the added latency is inaudible. */
const FRAME_SIZE = 512;
/** One render quantum. Making the hop equal to it means exactly one STFT frame
 *  per `process` call, with no additional buffering delay. */
const HOP_SIZE = 128;
const BIN_COUNT = FRAME_SIZE / 2 + 1;

/** How fast the measured spectrum follows the signal. A single periodogram bin
 *  fluctuates enormously frame to frame, and the minimum of a noisy estimate is
 *  far below its mean, so heavy smoothing here is what makes minimum tracking
 *  usable at all. */
const POWER_SMOOTHING = 0.9;
/**
 * Minimum statistics over a sliding window, kept as two half-windows so the
 * estimate is the minimum of the last one to two windows.
 *
 * An exponential creep cannot do this job: from a cold start it takes tens of
 * thousands of frames to reach the real floor, and until it gets there every
 * band reads as far above the noise and nothing is attenuated. A window
 * converges within its own length instead, still cannot be dragged up by speech
 * shorter than that length, and drops the instant the room goes quiet.
 *
 * ~1.5 s at 48 kHz: longer than any single utterance holds one band, short
 * enough to follow a room that changes.
 */
const NOISE_WINDOW_FRAMES = 560;

/** The frame buffer is zero-padded until this many hops have arrived. Measuring
 *  during the fill would seed the estimate from near-silence. */
const PRIMING_FRAMES = FRAME_SIZE / HOP_SIZE;

/** Minimum tracking is biased low by construction: it follows the troughs of a
 *  fluctuating estimate, not its mean. Without this correction the threshold
 *  lands under the noise it is meant to sit above, and nothing is attenuated. */
const NOISE_BIAS = 2;
/** Attenuate up to this many times the corrected noise estimate. Above 1
 *  because an estimate that is right on average is too low half the time. */
const OVER_SUBTRACTION = 2.5;
/** Never attenuate a band to silence: -24 dB of residual masks the artefacts
 *  that full removal would expose. */
const SPECTRAL_FLOOR = 0.06;
/** Per-bin gain smoothing over time. */
const GAIN_SMOOTHING = 0.7;

/**
 * Broadband level, relative to the current floor, above which a frame is taken
 * to contain speech and the floor is held rather than updated.
 *
 * Minimum tracking alone cannot tell a held vowel from a steady hum: both are
 * stationary, so the window minimum settles onto the vowel and suppresses it.
 * Freezing the estimate while the frame is loud keeps the floor at the level
 * measured before the speaker started.
 */
const SPEECH_PRESENCE_RATIO = 3;

const TINY = 1e-12;

function hannWindow(size) {
  const window = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
  }
  return window;
}

/**
 * Analysis and synthesis both window, so the overlap-add sums w² rather than w.
 * Measured rather than assumed, so the frame and hop can change without the
 * output level silently changing with them.
 */
function overlapAddNormalisation(window, hop) {
  let sum = 0;
  for (let offset = 0; offset < window.length; offset += hop) {
    sum += window[offset] * window[offset];
  }
  return sum || 1;
}

function bitReversalTable(size) {
  const table = new Uint32Array(size);
  const bits = Math.log2(size);
  for (let index = 0; index < size; index += 1) {
    let reversed = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      reversed = (reversed << 1) | ((index >>> bit) & 1);
    }
    table[index] = reversed;
  }
  return table;
}

/** In-place iterative radix-2 FFT. `inverse` skips the 1/N scaling, which the
 *  caller folds into the synthesis window instead. */
function transform(re, im, reversal, inverse) {
  const size = re.length;
  for (let index = 0; index < size; index += 1) {
    const target = reversal[index];
    if (target > index) {
      const tempRe = re[index];
      const tempIm = im[index];
      re[index] = re[target];
      im[index] = im[target];
      re[target] = tempRe;
      im[target] = tempIm;
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / span;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < size; start += span) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let offset = 0; offset < span / 2; offset += 1) {
        const a = start + offset;
        const b = a + span / 2;
        const productRe = re[b] * twiddleRe - im[b] * twiddleIm;
        const productIm = re[b] * twiddleIm + im[b] * twiddleRe;
        re[b] = re[a] - productRe;
        im[b] = im[a] - productIm;
        re[a] += productRe;
        im[a] += productIm;
        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }
}

class NoiseSuppressorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.window = hannWindow(FRAME_SIZE);
    this.normalisation = overlapAddNormalisation(this.window, HOP_SIZE);
    this.reversal = bitReversalTable(FRAME_SIZE);
    this.inputFrame = new Float32Array(FRAME_SIZE);
    this.outputFrame = new Float32Array(FRAME_SIZE);
    this.re = new Float32Array(FRAME_SIZE);
    this.im = new Float32Array(FRAME_SIZE);
    this.power = new Float32Array(BIN_COUNT);
    this.noise = new Float32Array(BIN_COUNT);
    this.windowMin = new Float32Array(BIN_COUNT).fill(Infinity);
    this.storedMin = new Float32Array(BIN_COUNT).fill(Infinity);
    this.gain = new Float32Array(BIN_COUNT).fill(1);
    this.smoothedGain = new Float32Array(BIN_COUNT).fill(1);
    this.seeded = false;
    this.framesSeen = 0;
    this.windowFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.enabled === "boolean") {
        this.enabled = event.data.enabled;
      }
    };
  }

  /**
   * Bypass still runs the full analysis and resynthesis. Switching the
   * preference must not change the latency of the graph, and the estimate has
   * to stay warm so re-enabling is immediate rather than starting from silence.
   */
  estimateAndAttenuate() {
    this.framesSeen += 1;
    if (this.framesSeen <= PRIMING_FRAMES) return;

    let totalPower = 0;
    let totalNoise = 0;
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const instant = this.re[bin] * this.re[bin] + this.im[bin] * this.im[bin];
      this.power[bin] = this.seeded
        ? POWER_SMOOTHING * this.power[bin] + (1 - POWER_SMOOTHING) * instant
        : instant;
      totalPower += this.power[bin];
      totalNoise += this.noise[bin];
    }

    const holdFloor = this.seeded && totalPower > totalNoise * SPEECH_PRESENCE_RATIO;
    const rotate = !holdFloor && ++this.windowFrames >= NOISE_WINDOW_FRAMES;

    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const measured = this.power[bin];
      if (!holdFloor) {
        this.windowMin[bin] = Math.min(this.windowMin[bin], measured);
        this.noise[bin] = Math.min(this.storedMin[bin], this.windowMin[bin]);
        if (rotate) {
          this.storedMin[bin] = this.windowMin[bin];
          this.windowMin[bin] = measured;
        }
      }

      // A posteriori SNR against the corrected floor, then a Wiener-style gain
      // with over-subtraction: bands near the floor collapse to it, bands well
      // above it pass almost untouched.
      const snr = measured / Math.max(this.noise[bin] * NOISE_BIAS, TINY);
      const target = snr <= OVER_SUBTRACTION
        ? SPECTRAL_FLOOR
        : Math.max(SPECTRAL_FLOOR, (snr - OVER_SUBTRACTION) / snr);
      this.gain[bin] = GAIN_SMOOTHING * this.gain[bin] + (1 - GAIN_SMOOTHING) * target;
    }
    this.seeded = true;
    if (rotate) this.windowFrames = 0;

    // Smoothing across neighbouring bins as well as across time. A gain that
    // varies sharply from one bin to the next rings as musical noise.
    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const previous = this.gain[Math.max(bin - 1, 0)];
      const next = this.gain[Math.min(bin + 1, BIN_COUNT - 1)];
      this.smoothedGain[bin] = this.enabled ? (previous + this.gain[bin] + next) / 3 : 1;
    }

    for (let bin = 0; bin < BIN_COUNT; bin += 1) {
      const applied = this.smoothedGain[bin];
      this.re[bin] *= applied;
      this.im[bin] *= applied;
      if (bin > 0 && bin < FRAME_SIZE / 2) {
        const mirror = FRAME_SIZE - bin;
        this.re[mirror] *= applied;
        this.im[mirror] *= applied;
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const source = input && input.length > 0 ? input[0] : null;

    this.inputFrame.copyWithin(0, HOP_SIZE);
    if (source) {
      this.inputFrame.set(source, FRAME_SIZE - HOP_SIZE);
    } else {
      this.inputFrame.fill(0, FRAME_SIZE - HOP_SIZE);
    }

    for (let index = 0; index < FRAME_SIZE; index += 1) {
      this.re[index] = this.inputFrame[index] * this.window[index];
      this.im[index] = 0;
    }
    transform(this.re, this.im, this.reversal, false);
    this.estimateAndAttenuate();
    transform(this.re, this.im, this.reversal, true);

    this.outputFrame.copyWithin(0, HOP_SIZE);
    this.outputFrame.fill(0, FRAME_SIZE - HOP_SIZE);
    const scale = 1 / (FRAME_SIZE * this.normalisation);
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      this.outputFrame[index] += this.re[index] * this.window[index] * scale;
    }

    const channel = output[0];
    for (let index = 0; index < HOP_SIZE && index < channel.length; index += 1) {
      channel[index] = this.outputFrame[index];
    }
    // One capture, one channel: any further outputs mirror the first so a
    // stereo-configured node does not go half silent.
    for (let extra = 1; extra < output.length; extra += 1) {
      output[extra].set(channel);
    }
    return true;
  }
}

registerProcessor("voxly-noise-suppressor", NoiseSuppressorProcessor);
