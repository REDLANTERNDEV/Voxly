import assert from "node:assert/strict";
import { test } from "node:test";
import { matrixReport } from "./matrix-report.mjs";

function cell(profile, bufferTarget, { loss = 0.02, delay = 50, paired = true, trials = 3, correction = 20 } = {}) {
  const comparisons = Array.from({ length: trials }, (_, index) =>
    ["voxly", "native"].map((path) => ({
      label: `${path}-network-${index}`,
      comparisons: [0, 1].map(() => ({
        comparisonAvailable: true,
        envelopeCorrelation: 0.99,
        missingSpeechFraction: loss,
        missingSpeechIntervals: 2,
        longestMissingSpeechMs: 50,
        estimatedDelayMs: delay
      })),
      network: { events: [] },
      decoders: [0, 1].map(() => ({
        measuredMs: 9000,
        unavailableMs: 0,
        replacements: [],
        rates: { spedUpMsPerSecond: correction, slowedDownMsPerSecond: 0 }
      }))
    }))
  ).flat();
  return {
    route: "direct",
    profile,
    bufferTarget,
    summary: {
      status: "passed",
      comparisons,
      pairedTrials: Array.from({ length: trials }, () => ({ paired, phaseDifferenceMs: [0, 0] }))
    }
  };
}

test("buffer candidate needs complete phase-aligned repeated and clean evidence", () => {
  const runs = [
    cell("clean", null),
    cell("clean", 80),
    cell("burst-loss", null),
    cell("burst-loss", 80, { loss: 0.01 })
  ];
  assert.equal(matrixReport(runs).assessments[0].candidateForWindowsValidation, true);
  assert.equal(matrixReport(runs).productionRecommendation, "retain-browser-default");
  for (const change of [{ paired: false }, { trials: 1 }, { correction: 30 }, { delay: 151 }]) {
    assert.equal(
      matrixReport([...runs.slice(0, 3), cell("burst-loss", 80, { loss: 0.01, ...change })]).assessments[0]
        .candidateForWindowsValidation,
      false
    );
  }
  assert.equal(matrixReport(runs.slice(2)).assessments[0].evidenceComplete, false);
  assert.equal(
    matrixReport([runs[0], cell("clean", 80, { loss: 0.04 }), ...runs.slice(2)]).assessments[0]
      .candidateForWindowsValidation,
    false
  );
  const delayed = cell("burst-loss", 80, { loss: 0.01 });
  delayed.summary.comparisons[0].comparisons[0].estimatedDelayMs = 160;
  assert.equal(matrixReport([...runs.slice(0, 3), delayed]).assessments[0].candidateForWindowsValidation, false);
});

test("missing decoder evidence cannot qualify an apparent waveform improvement", () => {
  const runs = [
    cell("clean", null),
    cell("clean", 40),
    cell("burst-loss", null),
    cell("burst-loss", 40, { loss: 0.01 })
  ];
  runs[3].summary.comparisons[0].decoders[0].rates.spedUpMsPerSecond = null;
  assert.equal(matrixReport(runs).assessments[0].evidenceComplete, false);
  runs[3].summary.comparisons[0].decoders[0].rates.spedUpMsPerSecond = 20;
  runs[3].summary.comparisons[1].decoders[0].unavailableMs = 9000;
  assert.equal(matrixReport(runs).assessments[0].evidenceComplete, false);
});

test("a failed matrix cell preserves a report without qualifying missing trials", () => {
  const failed = { route: "direct", profile: "clean", bufferTarget: null, summary: { status: "failed" } };
  const report = matrixReport([failed]);
  assert.equal(report.cells[0].usable, false);
  assert.equal(report.cells[0].trials, 0);
  assert.equal(report.cells[0].delayMs, null);
});
