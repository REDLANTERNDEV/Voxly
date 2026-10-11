const mean = (values) =>
  values.length && values.every(Number.isFinite) ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function matrixReport(runs) {
  const cells = runs.map(({ route, profile, bufferTarget, summary }) => {
    const pairedTrials = summary.pairedTrials ?? [];
    const actual = (summary.comparisons ?? []).filter((item) => item.label.startsWith("voxly-network-"));
    const reference = (summary.comparisons ?? []).filter((item) => item.label.startsWith("native-network-"));
    const speech = actual.flatMap((item) => item.comparisons);
    const decoders = actual.flatMap((item) => item.decoders);
    const nativeSpeech = reference.flatMap((item) => item.comparisons);
    const allDecoders = [...decoders, ...reference.flatMap((item) => item.decoders)];
    const schedulesMatch = actual.every(
      (item, index) =>
        item.network.events.length === reference[index]?.network.events.length &&
        item.network.events.every(
          (event, eventIndex) =>
            Math.abs(event.appliedAtMs - reference[index].network.events[eventIndex].appliedAtMs) <= 40
        )
    );
    const usable =
      summary.status === "passed" &&
      pairedTrials.length >= 3 &&
      pairedTrials.every((trial) => trial.paired) &&
      schedulesMatch &&
      speech.length === pairedTrials.length * 2 &&
      nativeSpeech.length === speech.length &&
      allDecoders.length === speech.length * 2 &&
      [...speech, ...nativeSpeech].every(
        (measurement) => measurement.comparisonAvailable && Number.isFinite(measurement.estimatedDelayMs)
      ) &&
      allDecoders.every(
        (decoder) =>
          decoder.measuredMs / (decoder.measuredMs + decoder.unavailableMs) >= 0.9 &&
          Object.values(decoder.rates).every(Number.isFinite)
      );
    return {
      route,
      profile,
      bufferTarget,
      usable,
      trials: pairedTrials.length,
      phaseDifferenceMs: pairedTrials.map((trial) => trial.phaseDifferenceMs),
      schedulesMatch,
      decoderCoverage: allDecoders.map((decoder) => decoder.measuredMs / (decoder.measuredMs + decoder.unavailableMs)),
      native: {
        missingSpeechFraction: mean(nativeSpeech.map((measurement) => measurement.missingSpeechFraction)),
        longestMissingSpeechMs: nativeSpeech.length
          ? Math.max(...nativeSpeech.map((measurement) => measurement.longestMissingSpeechMs ?? Infinity))
          : null,
        delayMs: mean(nativeSpeech.map((measurement) => measurement.estimatedDelayMs))
      },
      missingSpeechFraction: mean(speech.map((measurement) => measurement.missingSpeechFraction)),
      missingSpeechIntervals: mean(speech.map((measurement) => measurement.missingSpeechIntervals)),
      longestMissingSpeechMs: speech.length
        ? Math.max(...speech.map((measurement) => measurement.longestMissingSpeechMs ?? Infinity))
        : null,
      delayMs: mean(speech.map((measurement) => measurement.estimatedDelayMs)),
      delaysMs: speech.map((measurement) => measurement.estimatedDelayMs),
      speedCorrectionMsPerSecond: mean(
        decoders.map((decoder) => {
          const { spedUpMsPerSecond, slowedDownMsPerSecond } = decoder.rates;
          return Number.isFinite(spedUpMsPerSecond) && Number.isFinite(slowedDownMsPerSecond)
            ? spedUpMsPerSecond + slowedDownMsPerSecond
            : null;
        })
      ),
      peerReplacements: decoders.reduce((sum, decoder) => sum + decoder.replacements.length, 0),
      cleanRegressionGate:
        profile !== "clean"
          ? null
          : usable &&
            actual.every((item, index) =>
              item.comparisons.every((measurement, direction) => {
                const native = reference[index].comparisons[direction];
                return (
                  measurement.envelopeCorrelation >= 0.8 &&
                  native.envelopeCorrelation >= 0.8 &&
                  measurement.missingSpeechFraction <= native.missingSpeechFraction + 0.05 &&
                  measurement.longestMissingSpeechMs <= Math.max(150, native.longestMissingSpeechMs + 100)
                );
              })
            )
    };
  });
  const assessments = [];
  for (const candidate of cells.filter((cell) => cell.profile !== "clean" && cell.bufferTarget !== null)) {
    const baseline = cells.find(
      (cell) => cell.route === candidate.route && cell.profile === candidate.profile && cell.bufferTarget === null
    );
    const clean = cells.find(
      (cell) =>
        cell.route === candidate.route && cell.profile === "clean" && cell.bufferTarget === candidate.bufferTarget
    );
    const cleanDefault = cells.find(
      (cell) => cell.route === candidate.route && cell.profile === "clean" && cell.bufferTarget === null
    );
    const complete =
      candidate.usable && baseline?.usable && clean?.cleanRegressionGate && cleanDefault?.cleanRegressionGate;
    const cleanDoesNotRegress =
      complete &&
      clean.missingSpeechFraction <= cleanDefault.missingSpeechFraction + 0.005 &&
      clean.longestMissingSpeechMs <= cleanDefault.longestMissingSpeechMs + 20;
    const improved =
      complete &&
      cleanDoesNotRegress &&
      candidate.missingSpeechFraction < baseline.missingSpeechFraction &&
      candidate.longestMissingSpeechMs <= baseline.longestMissingSpeechMs &&
      candidate.speedCorrectionMsPerSecond <= baseline.speedCorrectionMsPerSecond;
    const addedDelayMs = complete
      ? Math.max(
          ...candidate.delaysMs.map((delay, index) => delay - baseline.delaysMs[index]),
          ...clean.delaysMs.map((delay, index) => delay - cleanDefault.delaysMs[index])
        )
      : null;
    assessments.push({
      route: candidate.route,
      profile: candidate.profile,
      bufferTarget: candidate.bufferTarget,
      evidenceComplete: Boolean(complete),
      cleanDoesNotRegress: Boolean(cleanDoesNotRegress),
      improved: Boolean(improved),
      addedDelayMs,
      candidateForWindowsValidation: Boolean(improved && addedDelayMs <= 100)
    });
  }
  return {
    cells,
    assessments,
    productionRecommendation: "retain-browser-default",
    limitation:
      "Buffer candidates still require repeated Windows Chrome runs, listening to synthetic WAVs, and an affected-laptop check. This matrix does not select or deploy a buffering change."
  };
}
