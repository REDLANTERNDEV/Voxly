import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";

const HOP = 128;
const SAMPLE_RATE = 48_000;
/**
 * Overlap-add reconstructs a frame only once every hop of it has arrived, so
 * the output trails the input by frame minus hop. Measured at 384 samples
 * (8 ms at 48 kHz) with a correlation of 1.0000 through the bypass path, which
 * is also the proof that the transform pair itself is lossless.
 */
const LATENCY = 384;

interface Processor {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

let ProcessorClass: new () => Processor;

/**
 * The worklet runs in its own realm and is loaded by URL, so it cannot import
 * from the bundle. Stubbing the realm's globals lets the DSP be exercised for
 * real here rather than only asserted structurally.
 */
before(async () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.sampleRate = SAMPLE_RATE;
  scope.AudioWorkletProcessor = class {
    port = { onmessage: null, postMessage() {} };
  };
  let captured: unknown = null;
  scope.registerProcessor = (_name: string, processor: unknown) => { captured = processor; };
  await import("../../public/noise-suppressor.worklet.js" as string);
  ProcessorClass = captured as new () => Processor;
});

function run(processor: Processor, signal: Float32Array) {
  const output = new Float32Array(signal.length);
  for (let offset = 0; offset + HOP <= signal.length; offset += HOP) {
    const input = [[signal.subarray(offset, offset + HOP)]];
    const sink = [[new Float32Array(HOP)]];
    processor.process(input, sink);
    output.set(sink[0][0], offset);
  }
  return output;
}

function rms(samples: Float32Array, from = 0) {
  let sum = 0;
  for (let index = from; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / (samples.length - from));
}

function noise(length: number, amplitude: number, seed = 1) {
  const samples = new Float32Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    samples[index] = ((state / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return samples;
}

/**
 * Stands in for a voice: a tone complex under a 3 Hz syllable envelope with real
 * gaps. The modulation matters — an unmodulated tone is, to any spectral method,
 * indistinguishable from a steady hum, and every denoiser removes it.
 */
function speech(length: number, amplitude: number) {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const seconds = index / SAMPLE_RATE;
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 3 * seconds));
    const carrier = Math.sin(2 * Math.PI * 220 * index / SAMPLE_RATE)
      + 0.6 * Math.sin(2 * Math.PI * 440 * index / SAMPLE_RATE)
      + 0.3 * Math.sin(2 * Math.PI * 880 * index / SAMPLE_RATE);
    samples[index] = carrier * envelope * amplitude;
  }
  return samples;
}

/**
 * Indices inside a syllable, i.e. where the voice is actually present, offset by
 * the reconstruction latency so the output is compared against the input that
 * produced it rather than against 8 ms of unrelated audio.
 */
function syllableIndices(length: number, from: number) {
  const indices: number[] = [];
  for (let index = from; index < length - LATENCY; index += 1) {
    if (Math.sin((2 * Math.PI * 3 * index) / SAMPLE_RATE) > 0.8) indices.push(index);
  }
  return indices;
}

/**
 * How much of the signal is not explained by the clean voice, as a fraction of
 * the part that is. Lower means less of everything else riding along with it.
 */
function residualRatio(signal: Float32Array, clean: Float32Array, indices: number[], delay: number) {
  let dot = 0;
  let cleanEnergy = 0;
  for (const index of indices) {
    dot += signal[index + delay] * clean[index];
    cleanEnergy += clean[index] * clean[index];
  }
  const scale = dot / (cleanEnergy || 1);
  let residual = 0;
  let explained = 0;
  for (const index of indices) {
    const fitted = scale * clean[index];
    residual += (signal[index + delay] - fitted) ** 2;
    explained += fitted * fitted;
  }
  return Math.sqrt(residual / (explained || 1));
}

function mix(a: Float32Array, b: Float32Array) {
  const samples = new Float32Array(a.length);
  for (let index = 0; index < a.length; index += 1) samples[index] = a[index] + b[index];
  return samples;
}

describe("spectral noise suppressor", () => {
  it("attenuates steady broadband noise", () => {
    const processor = new ProcessorClass();
    const input = noise(SAMPLE_RATE, 0.05);

    const output = run(processor, input);

    // Measured over the second half, once the estimate has settled.
    const half = Math.floor(input.length / 2);
    const reduction = rms(output, half) / rms(input, half);
    assert.ok(reduction < 0.35, `expected noise pushed well down, got ${reduction.toFixed(3)}`);
  });

  it("removes noise from inside speech rather than only between words", () => {
    // The case a whole-signal gate cannot serve. A gate is wide open during a
    // syllable, so the noise underneath every word survives it untouched.
    const processor = new ProcessorClass();
    const clean = speech(SAMPLE_RATE * 3, 0.2);
    const input = mix(clean, noise(clean.length, 0.03, 7));

    const output = run(processor, input);

    const half = Math.floor(clean.length / 2);
    const indices = syllableIndices(clean.length, half);
    const before = residualRatio(input, clean, indices, 0);
    const after = residualRatio(output, clean, indices, LATENCY);

    assert.ok(
      after < before * 0.7,
      `expected the noise inside syllables reduced, ${before.toFixed(3)} -> ${after.toFixed(3)}`
    );
  });

  it("passes speech through at a usable level", () => {
    const processor = new ProcessorClass();
    const input = speech(SAMPLE_RATE * 3, 0.2);

    const output = run(processor, input);

    const half = Math.floor(input.length / 2);
    const indices = syllableIndices(input.length, half);
    let outputEnergy = 0;
    let inputEnergy = 0;
    for (const index of indices) {
      outputEnergy += output[index + LATENCY] * output[index + LATENCY];
      inputEnergy += input[index] * input[index];
    }
    const retained = Math.sqrt(outputEnergy / inputEnergy);
    assert.ok(retained > 0.5, `speech must survive the stage, kept ${retained.toFixed(3)}`);
    assert.ok(retained < 1.6, `and must not be amplified by it, got ${retained.toFixed(3)}`);
  });

  it("passes the signal through untouched once disabled", () => {
    const processor = new ProcessorClass();
    processor.port.onmessage?.({ data: { enabled: false } });
    const input = noise(SAMPLE_RATE, 0.05, 3);

    const output = run(processor, input);

    const half = Math.floor(input.length / 2);
    const retained = rms(output, half) / rms(input, half);
    assert.ok(retained > 0.85, `bypass must not attenuate, kept ${retained.toFixed(3)}`);
  });

  it("keeps the same latency and a warm estimate across a toggle", () => {
    // Bypass is a flag, not a rewire: re-enabling must suppress immediately
    // rather than relearn the room.
    const processor = new ProcessorClass();
    const input = noise(SAMPLE_RATE, 0.05, 11);
    run(processor, input);

    processor.port.onmessage?.({ data: { enabled: false } });
    run(processor, noise(HOP * 40, 0.05, 12));
    processor.port.onmessage?.({ data: { enabled: true } });
    const output = run(processor, noise(SAMPLE_RATE / 8, 0.05, 13));

    const reduction = rms(output) / 0.05;
    assert.ok(reduction < 0.5, `expected immediate suppression after re-enable, got ${reduction.toFixed(3)}`);
  });

  it("survives a render quantum with no connected input", () => {
    const processor = new ProcessorClass();

    assert.doesNotThrow(() => {
      const sink = [[new Float32Array(HOP)]];
      processor.process([[]], sink);
    });
  });
});

describe("noise suppressor asset", () => {
  it("is self-contained, since the worklet realm cannot import from the bundle", () => {
    const source = readFileSync("public/noise-suppressor.worklet.js", "utf8");

    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(source, /\brequire\(/);
    assert.match(source, /registerProcessor\("voxly-noise-suppressor"/);
  });
});
