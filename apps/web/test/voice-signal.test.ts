import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { voiceSignalPresentation } from "../src/app/presentation.js";
import { translate, type LanguageCode, type TranslationKey } from "../src/lib/i18n.js";
import type { ConnectionHealth } from "../src/lib/useConnectionHealth.js";
import type { VoiceQuality } from "../src/lib/useVoiceQuality.js";

/**
 * The signal in the dock reported the Socket.IO round trip whether or not the
 * member was in a call. That number stays green through a voice fault, which is
 * how "my ping is fine" came to be offered as evidence that voice was working.
 * These pin the rule that in a call the signal reports the media instead.
 */
const translator = (language: LanguageCode) =>
  (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values);
const t = translator("en");

function health(overrides: Partial<ConnectionHealth> = {}): ConnectionHealth {
  return {
    quality: "good",
    rttMs: 34,
    overlayVisible: false,
    reconnectAttempt: 0,
    reason: "server_unreachable",
    ...overrides
  };
}

const measuring: VoiceQuality = { grade: "measuring", symptom: "none", reading: null, transport: null };

function quality(overrides: Partial<VoiceQuality> = {}): VoiceQuality {
  return {
    grade: "unstable",
    symptom: "speedUp",
    reading: {
      grade: "unstable",
      symptom: "speedUp",
      lossPercent: 0,
      concealedMs: 4,
      spedUpMs: 26,
      slowedDownMs: 0,
      bufferMs: 62
    },
    transport: null,
    ...overrides
  };
}

describe("dock connection signal", () => {
  it("reports the server round trip when there is no call to measure", () => {
    const signal = voiceSignalPresentation(health(), measuring, false, t);

    assert.equal(signal.value, "34 ms");
    assert.equal(signal.tone, "good");
  });

  it("shows neutral voice measurement until the first media sample lands", () => {
    // A server round trip is not evidence that the peer media path is healthy.
    const signal = voiceSignalPresentation(health(), measuring, true, t);

    assert.equal(signal.value, "Measuring voice");
    assert.doesNotMatch(signal.value, /ms/);
  });

  it("stops showing a healthy round trip as the verdict once in a call", () => {
    // The regression this exists for: a green 34 ms beside audio that is
    // audibly breaking up.
    const signal = voiceSignalPresentation(health(), quality({ grade: "breaking" }), true, t);

    assert.doesNotMatch(signal.value, /ms/);
    assert.equal(signal.tone, "poor");
  });

  it("names the symptom a member would describe, not a number", () => {
    const signal = voiceSignalPresentation(health(), quality(), true, t);

    assert.equal(signal.tone, "fair");
    assert.match(signal.label, /speeding up/);
  });

  it("carries the figures in the detail, which is what gets screenshotted", () => {
    const signal = voiceSignalPresentation(health(), quality({
      symptom: "loss",
      reading: {
        grade: "breaking",
        symptom: "loss",
        lossPercent: 9.2,
        concealedMs: 71,
        spedUpMs: 0,
        slowedDownMs: 0,
        bufferMs: 55
      }
    }), true, t);

    assert.match(signal.label, /9\.2%/);
    assert.match(signal.label, /71 ms/);
    assert.match(signal.label, /55 ms/);
  });

  it("reports the media route separately from the signalling round trip", () => {
    const signal = voiceSignalPresentation(health(), quality({
      transport: { rttMs: 210, candidateType: "relay", candidatePairState: "succeeded" }
    }), true, t);

    assert.match(signal.label, /TURN/);
    assert.match(signal.label, /210 ms/);
  });

  it("stays readable in Turkish, where the reports came from", () => {
    const signal = voiceSignalPresentation(health(), quality({
      transport: { rttMs: 210, candidateType: "relay", candidatePairState: "succeeded" }
    }), true, translator("tr"));

    assert.equal(signal.value, "Dalgalı");
    assert.match(signal.label, /hızlanması/);
    assert.match(signal.label, /TURN üzerinden/);
  });
});

describe("voice signal generations", () => {
  it("does not reuse candidates after a peer replacement", () => {
    const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");

    assert.match(source, /pendingCandidatesRef = useRef<Map<string, \{ generation: number/);
    assert.match(source, /pending\?\.generation === peerGeneration/);
    assert.match(source, /isCurrentPeer\(peerUserId, peer, peerGeneration\)/);
  });
});
