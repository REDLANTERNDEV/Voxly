import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readVoiceCounters,
  voiceQualityReading,
  worstVoiceQuality,
  type VoiceCounters
} from "../src/lib/voiceQuality.js";

const SAMPLE_RATE = 48_000;
/** One second of played audio, which is the denominator every rate uses. */
const SECOND = SAMPLE_RATE;

function counters(overrides: Partial<VoiceCounters> = {}): VoiceCounters {
  return {
    packetsReceived: 0,
    packetsLost: 0,
    concealedSamples: 0,
    silentConcealedSamples: 0,
    removedSamplesForAcceleration: 0,
    insertedSamplesForDeceleration: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    ...overrides
  };
}

/** A clean second: 50 packets, nothing lost, nothing concealed. */
function clean(overrides: Partial<VoiceCounters> = {}) {
  return counters({
    packetsReceived: 50,
    jitterBufferEmittedCount: SECOND,
    jitterBufferDelay: 0.04,
    ...overrides
  });
}

describe("voice quality counters", () => {
  it("sums only the inbound audio entries in a report", () => {
    const totals = readVoiceCounters([
      { type: "inbound-rtp", kind: "audio", packetsReceived: 40, packetsLost: 2 },
      { type: "inbound-rtp", kind: "video", packetsReceived: 900, packetsLost: 90 },
      { type: "outbound-rtp", kind: "audio", packetsSent: 40 },
      { type: "candidate-pair", nominated: true }
    ]);

    assert.equal(totals.packetsReceived, 40);
    assert.equal(totals.packetsLost, 2);
  });

  it("survives a report whose fields are missing or not numbers", () => {
    const totals = readVoiceCounters([
      { type: "inbound-rtp", kind: "audio", packetsReceived: undefined, concealedSamples: "many" }
    ]);

    assert.equal(totals.packetsReceived, 0);
    assert.equal(totals.concealedSamples, 0);
  });
});

describe("voice quality reading", () => {
  it("reports nothing until enough audio has played to divide by", () => {
    // A member alone, deafened, or in a silent room. Reporting "clear" here
    // would be a verdict on a path nothing crossed.
    const reading = voiceQualityReading(clean(), clean({ jitterBufferEmittedCount: SECOND + 500 }));

    assert.equal(reading, null);
  });

  it("grades an ordinary second as clear", () => {
    const reading = voiceQualityReading(
      clean(),
      clean({ packetsReceived: 100, jitterBufferEmittedCount: SECOND * 2, jitterBufferDelay: 0.08 })
    );

    assert.ok(reading);
    assert.equal(reading.grade, "clear");
    assert.equal(reading.symptom, "none");
    assert.equal(Math.round(reading.bufferMs), 40);
  });

  it("names lost packets when concealment has loss behind it", () => {
    const reading = voiceQualityReading(clean(), clean({
      packetsReceived: 145,
      packetsLost: 5,
      // 30 ms of invented audio to cover the gaps the loss left.
      concealedSamples: SAMPLE_RATE * 0.03,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(reading);
    assert.equal(reading.symptom, "loss");
    assert.equal(reading.grade, "breaking");
    assert.ok(reading.lossPercent > 4.9 && reading.lossPercent < 5.1, `got ${reading.lossPercent}`);
  });

  it("distinguishes late packets from lost ones", () => {
    // The same crackle, a different fault: everything arrived, too late to use.
    const reading = voiceQualityReading(clean(), clean({
      packetsReceived: 100,
      concealedSamples: SAMPLE_RATE * 0.04,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(reading);
    assert.equal(reading.symptom, "jitter");
    assert.equal(reading.lossPercent, 0);
  });

  it("does not count silent concealment against the path", () => {
    // A talker who stopped sending is what discontinuous transmission is for.
    const reading = voiceQualityReading(clean(), clean({
      packetsReceived: 100,
      concealedSamples: SAMPLE_RATE * 0.5,
      silentConcealedSamples: SAMPLE_RATE * 0.5,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(reading);
    assert.equal(reading.grade, "clear");
    assert.equal(reading.symptom, "none");
  });

  it("names speeding up, which is the symptom members describe", () => {
    const reading = voiceQualityReading(clean(), clean({
      packetsReceived: 100,
      removedSamplesForAcceleration: SAMPLE_RATE * 0.05,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(reading);
    assert.equal(reading.symptom, "speedUp");
    assert.equal(reading.grade, "unstable");
    assert.ok(Math.round(reading.spedUpMs) >= 24, `got ${reading.spedUpMs}`);
  });

  it("names slowing down separately from speeding up", () => {
    const reading = voiceQualityReading(clean(), clean({
      packetsReceived: 100,
      insertedSamplesForDeceleration: SAMPLE_RATE * 0.05,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(reading);
    assert.equal(reading.symptom, "slowDown");
  });

  it("floors a revised loss count rather than reporting a negative rate", () => {
    // `packetsLost` is signed and a receiver may revise it down when a packet
    // it had given up on finally arrives.
    const reading = voiceQualityReading(
      clean({ packetsLost: 10 }),
      clean({ packetsReceived: 100, packetsLost: 4, jitterBufferEmittedCount: SECOND * 2 })
    );

    assert.ok(reading);
    assert.equal(reading.lossPercent, 0);
    assert.equal(reading.grade, "clear");
  });

  it("normalises by audio played, not by wall clock", () => {
    // A throttled background tab samples less often. The same fault must read
    // the same either way, or throttling is reported as a network problem.
    const oneSecond = voiceQualityReading(clean(), clean({
      packetsReceived: 100,
      concealedSamples: SAMPLE_RATE * 0.02,
      jitterBufferEmittedCount: SECOND * 2
    }));
    const fourSeconds = voiceQualityReading(clean(), clean({
      packetsReceived: 250,
      concealedSamples: SAMPLE_RATE * 0.08,
      jitterBufferEmittedCount: SECOND * 5
    }));

    assert.ok(oneSecond && fourSeconds);
    assert.ok(
      Math.abs(oneSecond.concealedMs - fourSeconds.concealedMs) < 0.5,
      `${oneSecond.concealedMs} vs ${fourSeconds.concealedMs}`
    );
  });
});

describe("worst voice quality", () => {
  it("reports the room as its worst peer rather than its average", () => {
    // Three good peers must not divide one bad peer's fault by four.
    const good = voiceQualityReading(clean(), clean({ packetsReceived: 100, jitterBufferEmittedCount: SECOND * 2 }));
    const bad = voiceQualityReading(clean(), clean({
      packetsReceived: 142,
      packetsLost: 8,
      concealedSamples: SAMPLE_RATE * 0.08,
      jitterBufferEmittedCount: SECOND * 2
    }));

    assert.ok(good && bad);
    assert.equal(worstVoiceQuality([good, good, bad, good])?.grade, "breaking");
  });

  it("has nothing to report when no peer produced a reading", () => {
    assert.equal(worstVoiceQuality([]), null);
  });
});
