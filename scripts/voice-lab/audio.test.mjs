import assert from 'node:assert/strict';
import { test } from 'node:test';
import { metrics, compare, fixture } from './audio.mjs';

test('silence and clipped audio have distinct measured signatures', () => {
  assert.equal(metrics(new Float32Array(48000)).rms, 0);
  assert.equal(metrics(new Float32Array(48000).fill(1)).clippedFraction, 1);
});
test('seeded noise is repeatable and silence stays digital zero', () => {
  const speech = new Float32Array(48000).fill(0.1);
  assert.deepEqual(fixture(speech, 'noise'), fixture(speech, 'noise'));
  assert.equal(metrics(fixture(speech, 'silence')).peak, 0);
});
test('timing comparison finds a known delay and detects an omitted word', () => {
  const envelope = Array.from({ length: 500 }, (_, index) => index % 83 < 30 ? 0.2 + Math.sin(index) * 0.04 : 0);
  const received = [0, 0, 0, 0, 0, ...envelope];
  const result = compare({ envelope }, { envelope: received }, 1000, 1000);
  assert.equal(result.estimatedDelayMs, 50);
  assert.ok(result.envelopeCorrelation > 0.99);
  const damaged = [...received]; damaged.fill(0, 171, 196);
  const broken = compare({ envelope }, { envelope: damaged }, 1000, 1000);
  assert.ok(broken.missingSpeechFraction > result.missingSpeechFraction);
  assert.ok(broken.longestMissingSpeechMs >= 200);
});

test('silence cannot claim a measured delay or speech continuity', () => {
  const result = compare(metrics(new Float32Array(48000)), metrics(new Float32Array(48000)), 1000, 1000);
  assert.equal(result.comparisonAvailable, false);
  assert.equal(result.estimatedDelayMs, null);
  assert.equal(result.missingSpeechFraction, null);
});

test('decoder rates use one window and reject new receiver generations', async () => {
  const { decoderRates } = await import('./audio.mjs');
  const audio = { streamAlias: 1, packetsReceived: 50, packetsLost: 0, jitterBufferEmittedCount: 48000,
    concealedSamples: 0, silentConcealedSamples: 0, removedSamplesForAcceleration: 0,
    insertedSamplesForDeceleration: 0, jitterBufferDelay: 1920 };
  const before = [{ peerAlias: 1, audio: [audio] }];
  const after = [{ peerAlias: 1, audio: [{ ...audio, packetsReceived: 100, jitterBufferEmittedCount: 96000,
    removedSamplesForAcceleration: 5760, jitterBufferDelay: 3840 }] }];
  assert.equal(decoderRates(before, after)[0].bufferMs, 40);
  assert.equal(decoderRates(before, after)[0].spedUpMsPerSecond, 120);
  assert.equal(decoderRates(before, [{ ...after[0], peerAlias: 2 }])[0].available, false);
});

test('ended receivers explicitly report unavailable decoder measurements', async () => {
  const { decoderRates } = await import('./audio.mjs');
  const before = [{ peerAlias: 1, audio: [{ streamAlias: 1 }] }];
  assert.deepEqual(decoderRates(before, [{ peerAlias: 1, audio: [] }]), [
    { peerAlias: 1, streamAlias: 1, available: false, reason: 'receiver-ended' }
  ]);
});
