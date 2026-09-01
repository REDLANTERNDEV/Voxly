/**
 * What the voice path is actually doing, measured on the media itself.
 *
 * The signal next to the controls reports the Socket.IO round trip to the
 * signalling server. That number is green whenever chat works — which is most
 * of the time somebody is complaining about voice — so "my ping is fine" has
 * never been evidence about the call. Voice travels peer to peer over UDP and
 * is judged by entirely different quantities.
 *
 * The receiving decoder already keeps them, and each one corresponds to
 * something a member can hear. Covering a gap with invented samples is heard as
 * crackle. Dropping samples to drain an overfull buffer is heard as the speaker
 * suddenly speeding up. Stretching samples to refill an emptying one is heard
 * as slowing down. Reading those counters turns a description of a symptom into
 * the measurement that names its cause, which is the difference between a
 * report we can act on and one we can only guess at.
 */

/** WebRTC decodes Opus at 48 kHz, and every sample counter here is in that clock. */
const decoderSampleRate = 48_000;

/**
 * Rates are expressed per second of audio actually played, not per second of
 * wall clock. A backgrounded tab throttles the timer that samples these
 * counters, and dividing by elapsed time would report that throttling as a
 * network fault. The decoder's own emitted-sample count is the honest
 * denominator: it advances only while audio is being played.
 */
const minimumEmittedSamples = decoderSampleRate / 4;

/** Below this the effect is shorter than a syllable and nobody reports it. */
const audibleMsPerSecond = 10;
/** Loss this low is what forward error correction exists to absorb. */
const lossyPercent = 1;
/** Loss and concealment at which the call stops being usable rather than rough. */
const breakingPercent = 5;
const breakingMsPerSecond = 60;

export type VoiceQualityGrade = "measuring" | "clear" | "unstable" | "breaking";

/**
 * The dominant thing the member hears, named as they would describe it. Loss
 * and jitter both surface as crackle, and separating them is the whole point:
 * one is packets that never arrived, the other packets that arrived too late.
 */
export type VoiceQualitySymptom = "none" | "loss" | "jitter" | "speedUp" | "slowDown";

export interface VoiceCounters {
  packetsReceived: number;
  packetsLost: number;
  concealedSamples: number;
  silentConcealedSamples: number;
  removedSamplesForAcceleration: number;
  insertedSamplesForDeceleration: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
}

export interface VoiceQualityReading {
  grade: VoiceQualityGrade;
  symptom: VoiceQualitySymptom;
  /** Packets that never arrived, as a percentage of those expected. */
  lossPercent: number;
  /** Milliseconds of invented audio per second played — the crackle itself. */
  concealedMs: number;
  /** Milliseconds discarded per second played, heard as speeding up. */
  spedUpMs: number;
  /** Milliseconds inserted per second played, heard as slowing down. */
  slowedDownMs: number;
  /** How much audio the decoder is holding back to absorb jitter. */
  bufferMs: number;
}

const emptyCounters: VoiceCounters = {
  packetsReceived: 0,
  packetsLost: 0,
  concealedSamples: 0,
  silentConcealedSamples: 0,
  removedSamplesForAcceleration: 0,
  insertedSamplesForDeceleration: 0,
  jitterBufferDelay: 0,
  jitterBufferEmittedCount: 0
};

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * A peer usually carries one inbound audio stream, but it carries two while its
 * screen share has audio, and a renegotiation can leave a third set of counters
 * behind. Summing is correct for every quantity here — each is a running total
 * of samples or packets — and it is also the right question: all of it is audio
 * the member is hearing from that peer.
 */
export function readVoiceCounters(report: Iterable<Record<string, unknown>>): VoiceCounters {
  const totals = { ...emptyCounters };
  for (const entry of report) {
    if (entry.type !== "inbound-rtp" || entry.kind !== "audio") continue;
    totals.packetsReceived += count(entry.packetsReceived);
    totals.packetsLost += count(entry.packetsLost);
    totals.concealedSamples += count(entry.concealedSamples);
    totals.silentConcealedSamples += count(entry.silentConcealedSamples);
    totals.removedSamplesForAcceleration += count(entry.removedSamplesForAcceleration);
    totals.insertedSamplesForDeceleration += count(entry.insertedSamplesForDeceleration);
    totals.jitterBufferDelay += count(entry.jitterBufferDelay);
    totals.jitterBufferEmittedCount += count(entry.jitterBufferEmittedCount);
  }
  return totals;
}

/**
 * `packetsLost` is a signed field that a receiver may revise downwards when a
 * packet it had given up on arrives, so every delta is floored at zero rather
 * than trusted to rise.
 */
function delta(previous: number, next: number) {
  return Math.max(0, next - previous);
}

function samplesToMs(samples: number, perSecond: number) {
  return (samples / decoderSampleRate) * 1000 / perSecond;
}

function gradeFor(lossPercent: number, concealedMs: number, resyncMs: number): VoiceQualityGrade {
  if (lossPercent >= breakingPercent || concealedMs >= breakingMsPerSecond) return "breaking";
  if (lossPercent >= lossyPercent || concealedMs >= audibleMsPerSecond || resyncMs >= audibleMsPerSecond) {
    return "unstable";
  }
  return "clear";
}

function symptomFor(lossPercent: number, concealedMs: number, spedUpMs: number, slowedDownMs: number) {
  if (spedUpMs >= audibleMsPerSecond && spedUpMs >= slowedDownMs && spedUpMs >= concealedMs) return "speedUp";
  if (slowedDownMs >= audibleMsPerSecond && slowedDownMs >= concealedMs) return "slowDown";
  if (concealedMs >= audibleMsPerSecond || lossPercent >= lossyPercent) {
    // Concealment with no loss behind it means the packets did arrive, just too
    // late for the buffer to wait — a different fault with a different remedy.
    return lossPercent >= lossyPercent ? "loss" : "jitter";
  }
  return "none";
}

/**
 * Null until enough audio has played between two samples to divide by. A member
 * who is alone, deafened, or in a silent room produces no denominator, and
 * inventing one would report perfect quality for a path nothing crossed.
 */
export function voiceQualityReading(previous: VoiceCounters, next: VoiceCounters): VoiceQualityReading | null {
  const emitted = delta(previous.jitterBufferEmittedCount, next.jitterBufferEmittedCount);
  if (emitted < minimumEmittedSamples) return null;

  const perSecond = emitted / decoderSampleRate;
  const lost = delta(previous.packetsLost, next.packetsLost);
  const received = delta(previous.packetsReceived, next.packetsReceived);
  const expected = lost + received;

  // Silent concealment covers a talker who simply stopped sending, which is
  // what discontinuous transmission is for and is inaudible by design.
  const audibleConcealed = Math.max(
    0,
    delta(previous.concealedSamples, next.concealedSamples)
      - delta(previous.silentConcealedSamples, next.silentConcealedSamples)
  );

  const lossPercent = expected > 0 ? (lost / expected) * 100 : 0;
  const concealedMs = samplesToMs(audibleConcealed, perSecond);
  const spedUpMs = samplesToMs(
    delta(previous.removedSamplesForAcceleration, next.removedSamplesForAcceleration),
    perSecond
  );
  const slowedDownMs = samplesToMs(
    delta(previous.insertedSamplesForDeceleration, next.insertedSamplesForDeceleration),
    perSecond
  );
  const bufferMs = (delta(previous.jitterBufferDelay, next.jitterBufferDelay) / perSecond) * 1000;

  return {
    grade: gradeFor(lossPercent, concealedMs, Math.max(spedUpMs, slowedDownMs)),
    symptom: symptomFor(lossPercent, concealedMs, spedUpMs, slowedDownMs),
    lossPercent,
    concealedMs,
    spedUpMs,
    slowedDownMs,
    bufferMs
  };
}

const gradeSeverity: Record<VoiceQualityGrade, number> = {
  measuring: 0,
  clear: 1,
  unstable: 2,
  breaking: 3
};

/**
 * One rough speaker ruins a call that is otherwise fine, so the room is
 * reported as its worst peer rather than its average. An average over four
 * peers divides a real fault by four and shows green through it.
 */
export function worstVoiceQuality(readings: readonly VoiceQualityReading[]): VoiceQualityReading | null {
  let worst: VoiceQualityReading | null = null;
  for (const reading of readings) {
    if (!worst) {
      worst = reading;
      continue;
    }
    const severity = gradeSeverity[reading.grade] - gradeSeverity[worst.grade];
    if (severity > 0 || (severity === 0 && reading.lossPercent > worst.lossPercent)) worst = reading;
  }
  return worst;
}
