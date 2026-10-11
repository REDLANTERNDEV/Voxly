import { readFileSync, writeFileSync } from "node:fs";

export function decodeWav(path) {
  const data = readFileSync(path);
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("Expected PCM WAV");
  let format, samples;
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = data.readUInt32LE(offset + 4),
      start = offset + 8;
    if (data.toString("ascii", offset, offset + 4) === "fmt ")
      format = {
        pcm: data.readUInt16LE(start),
        channels: data.readUInt16LE(start + 2),
        rate: data.readUInt32LE(start + 4),
        bits: data.readUInt16LE(start + 14)
      };
    if (data.toString("ascii", offset, offset + 4) === "data") samples = data.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (
    !format ||
    format.pcm !== 1 ||
    format.channels !== 1 ||
    format.rate !== 48000 ||
    format.bits !== 16 ||
    !samples?.length
  )
    throw new Error("Fixture must be nonempty mono 48 kHz PCM16 WAV");
  return Float32Array.from({ length: samples.length / 2 }, (_, index) => samples.readInt16LE(index * 2) / 32768);
}
export function writeWav(path, samples, sampleRate = 48000) {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write("RIFF");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) =>
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), 44 + index * 2)
  );
  writeFileSync(path, result);
}
export function fixture(speech, kind) {
  let seed = 937;
  return Float32Array.from(speech, (sample) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return kind === "silence"
      ? 0
      : Math.max(-1, Math.min(1, sample + (kind === "noise" ? (seed / 4294967296 - 0.5) * 0.03 : 0)));
  });
}
export function metrics(samples, sampleRate = 48000) {
  let energy = 0,
    peak = 0,
    clipping = 0;
  const envelope = [];
  for (let i = 0; i < samples.length; i += 480) {
    let block = 0;
    for (const sample of samples.slice(i, i + 480)) {
      energy += sample * sample;
      block += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      if (Math.abs(sample) >= 0.999) clipping++;
    }
    envelope.push(Math.sqrt(block / Math.min(480, samples.length - i)));
  }
  let longest = 0,
    run = 0;
  for (const value of envelope) {
    run = value < 0.0005 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    durationMs: (samples.length / sampleRate) * 1000,
    firstSpeechMs: envelope.some((value) => value > 0.0001)
      ? envelope.findIndex((value) => value > Math.max(0.0001, Math.max(...envelope) * 0.08)) * 10
      : null,
    rms: Math.sqrt(energy / Math.max(1, samples.length)),
    peak,
    clippedFraction: clipping / Math.max(1, samples.length),
    longestQuietMs: longest * 10,
    envelope
  };
}
// Compare 10 ms envelopes, not pitch-sensitive PCM. Useful for timing/omissions;
// not a perceptual score and not proof of natural-sounding speech.
export function compare(source, received, sourceStart, receivedStart) {
  const a = source.envelope,
    b = received.envelope;
  if (!a.some((value) => value > 0.0001)) {
    return {
      comparisonAvailable: false,
      envelopeCorrelation: null,
      estimatedDelayMs: null,
      missingSpeechFraction: null,
      missingSpeechIntervals: null,
      longestMissingSpeechMs: null
    };
  }
  const receivedSpeech = b.some((value) => value > 0.0001);
  let best = { correlation: -1, lag: 0 };
  for (let lag = receivedSpeech ? -100 : 0; lag <= (receivedSpeech ? 100 : 0); lag++) {
    let aa = 0,
      bb = 0,
      ab = 0,
      n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      aa += a[i] ** 2;
      bb += b[j] ** 2;
      ab += a[i] * b[j];
      n++;
    }
    if (n < 100) continue;
    const correlation = ab / Math.max(1e-12, Math.sqrt(aa * bb));
    if (correlation > best.correlation) best = { correlation, lag };
  }
  const sourcePeak = Math.max(...a, 0.000001),
    receivedPeak = Math.max(...b, 0.000001);
  let active = 0,
    missing = 0,
    missingIntervals = 0,
    missingRun = 0,
    longestMissing = 0;
  for (let i = 0; i < a.length; i++) {
    const j = i + best.lag;
    if (j < 0 || j >= b.length) continue;
    const expected = a[i] > sourcePeak * 0.08;
    const absent = expected && b[j] < receivedPeak * 0.02;
    if (expected) active++;
    if (absent) missing++;
    if (absent && missingRun === 0) missingIntervals++;
    missingRun = absent ? missingRun + 1 : 0;
    longestMissing = Math.max(longestMissing, missingRun);
  }
  return {
    comparisonAvailable: best.correlation >= 0,
    envelopeCorrelation: best.correlation,
    estimatedDelayMs: receivedSpeech ? receivedStart - sourceStart + best.lag * 10 : null,
    missingSpeechFraction: missing / Math.max(1, active),
    missingSpeechIntervals: missingIntervals,
    longestMissingSpeechMs: longestMissing * 10
  };
}

/** Windowed decoder rates; lifetime totals cannot compare two network trials. */
export function decoderRates(before, after) {
  const baseline = new Map(
    before.flatMap((peer) => peer.audio.map((audio) => [`${peer.peerAlias}:${audio.streamAlias}`, audio]))
  );
  const current = new Set(after.flatMap((peer) => peer.audio.map((audio) => `${peer.peerAlias}:${audio.streamAlias}`)));
  const readings = after.flatMap((peer) =>
    peer.audio.map((audio) => {
      const previous = baseline.get(`${peer.peerAlias}:${audio.streamAlias}`);
      const emitted = audio.jitterBufferEmittedCount - (previous?.jitterBufferEmittedCount ?? 0);
      if (
        !previous ||
        !Number.isFinite(emitted) ||
        emitted < 12000 ||
        audio.packetsReceived < previous.packetsReceived
      ) {
        return { peerAlias: peer.peerAlias, streamAlias: audio.streamAlias, available: false };
      }
      const delta = (field) =>
        typeof audio[field] === "number" && typeof previous[field] === "number"
          ? Math.max(0, audio[field] - previous[field])
          : null;
      const received = delta("packetsReceived"),
        lost = delta("packetsLost");
      const concealed = delta("concealedSamples"),
        silent = delta("silentConcealedSamples");
      const acceleration = delta("removedSamplesForAcceleration"),
        deceleration = delta("insertedSamplesForDeceleration"),
        buffer = delta("jitterBufferDelay");
      return {
        peerAlias: peer.peerAlias,
        streamAlias: audio.streamAlias,
        available: true,
        emittedSamples: emitted,
        lossPercent:
          received !== null && lost !== null && received + lost > 0 ? (lost / (received + lost)) * 100 : null,
        concealedMsPerSecond:
          concealed !== null && silent !== null ? (Math.max(0, concealed - silent) / emitted) * 1000 : null,
        spedUpMsPerSecond: acceleration !== null ? (acceleration / emitted) * 1000 : null,
        slowedDownMsPerSecond: deceleration !== null ? (deceleration / emitted) * 1000 : null,
        bufferMs: buffer !== null ? (buffer / emitted) * 1000 : null
      };
    })
  );
  for (const peer of before)
    for (const audio of peer.audio) {
      if (!current.has(`${peer.peerAlias}:${audio.streamAlias}`))
        readings.push({
          peerAlias: peer.peerAlias,
          streamAlias: audio.streamAlias,
          available: false,
          reason: "receiver-ended"
        });
    }
  return readings;
}

/** Sum disjoint stable decoder windows; replacement intervals remain unknown. */
export function decoderTimeline(snapshots) {
  const fields = ["lossPercent", "concealedMsPerSecond", "spedUpMsPerSecond", "slowedDownMsPerSecond", "bufferMs"];
  const windows = [];
  const replacements = [];
  const knownPeers = new Set(snapshots[0]?.peers.map((peer) => peer.peerAlias));
  let measuredMs = 0;
  let unavailableMs = 0;
  for (let index = 1; index < snapshots.length; index++) {
    const before = snapshots[index - 1],
      after = snapshots[index];
    const durationMs = Math.max(0, after.atMs - before.atMs);
    const readings = decoderRates(before.peers, after.peers);
    const complete =
      readings.length > 0 &&
      readings.every((reading) => reading.available && fields.every((field) => Number.isFinite(reading[field])));
    measuredMs += complete ? durationMs : 0;
    unavailableMs += complete ? 0 : durationMs;
    windows.push({ atMs: after.atMs, durationMs, complete, readings });
    for (const peer of after.peers) {
      if (!knownPeers.has(peer.peerAlias)) replacements.push({ atMs: after.atMs, peerAlias: peer.peerAlias });
      knownPeers.add(peer.peerAlias);
    }
  }
  const available = windows.flatMap((window) => window.readings.filter((reading) => reading.available));
  const rates = Object.fromEntries(
    fields.map((field) => {
      const readings = available.filter((reading) => Number.isFinite(reading[field]));
      const emitted = readings.reduce((sum, reading) => sum + reading.emittedSamples, 0);
      return [
        field,
        emitted ? readings.reduce((sum, reading) => sum + reading[field] * reading.emittedSamples, 0) / emitted : null
      ];
    })
  );
  return { measuredMs, unavailableMs, rates, replacements, windows };
}

/** Both transport paths must encounter the same word/pause phase. */
export function phaseDifference(actual, reference) {
  const onset = (result) => {
    const first = result.recordings.find((recording) => recording.stage === "capture")?.metrics.firstSpeechMs;
    return Number.isFinite(first) && Number.isFinite(result.fixtureStartAt)
      ? result.startedAt + first - result.fixtureStartAt
      : null;
  };
  const a = onset(actual),
    b = onset(reference);
  return a === null || b === null ? null : Math.abs(a - b);
}
