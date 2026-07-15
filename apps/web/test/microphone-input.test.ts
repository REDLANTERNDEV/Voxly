import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMicrophoneInput } from "../src/lib/microphoneInput.js";

function track() {
  return {
    readyState: "live",
    stops: 0,
    stop() {
      this.stops += 1;
      this.readyState = "ended";
    }
  };
}

function stream(id: string) {
  const audioTrack = track();
  return {
    id,
    audioTrack,
    getTracks: () => [audioTrack],
    getAudioTracks: () => [audioTrack]
  };
}

function audioGraph() {
  const raw = stream("raw");
  const voice = stream("voice");
  const monitor = stream("monitor");
  const sourceConnections: unknown[] = [];
  const gainConnections: unknown[] = [];
  const source = {
    disconnects: 0,
    connect(node: unknown) { sourceConnections.push(node); },
    disconnect() { this.disconnects += 1; }
  };
  const gain = {
    gain: { value: 1 },
    disconnects: 0,
    connect(node: unknown) { gainConnections.push(node); },
    disconnect() { this.disconnects += 1; }
  };
  const destinations = [{ stream: voice }, { stream: monitor }];
  const context = {
    closes: 0,
    resumes: 0,
    createMediaStreamSource(received: unknown) {
      assert.equal(received, raw);
      return source;
    },
    createGain: () => gain,
    createMediaStreamDestination: () => destinations.shift(),
    async resume() { this.resumes += 1; },
    async close() { this.closes += 1; }
  };
  return { context, gain, gainConnections, monitor, raw, source, sourceConnections, voice };
}

describe("microphone input processing", () => {
  it("feeds voice and monitor streams through one shared input gain", () => {
    const graph = audioGraph();
    const input = createMicrophoneInput(
      graph.raw as unknown as MediaStream,
      135,
      () => graph.context as unknown as AudioContext
    );

    assert.equal(input.voiceStream, graph.voice);
    assert.equal(input.monitorStream, graph.monitor);
    assert.deepEqual(graph.sourceConnections, [graph.gain]);
    assert.deepEqual(graph.gainConnections, [{ stream: graph.voice }, { stream: graph.monitor }]);
    assert.equal(graph.gain.gain.value, 1.35);
    assert.equal(graph.context.resumes, 1);

    input.setVolume(60);
    assert.equal(graph.gain.gain.value, 0.6);
  });

  it("stops raw and generated tracks exactly once during cleanup", () => {
    const graph = audioGraph();
    const input = createMicrophoneInput(
      graph.raw as unknown as MediaStream,
      100,
      () => graph.context as unknown as AudioContext
    );

    input.dispose();
    input.dispose();

    assert.equal(graph.raw.audioTrack.stops, 1);
    assert.equal(graph.voice.audioTrack.stops, 1);
    assert.equal(graph.monitor.audioTrack.stops, 1);
    assert.equal(graph.source.disconnects, 1);
    assert.equal(graph.gain.disconnects, 1);
    assert.equal(graph.context.closes, 1);
  });

  it("stops the raw capture when an audio graph cannot be created", () => {
    const raw = stream("raw");

    assert.throws(() => createMicrophoneInput(
      raw as unknown as MediaStream,
      100,
      () => { throw new Error("unavailable"); }
    ));
    assert.equal(raw.audioTrack.stops, 1);
  });

  it("closes a partially created audio context when graph setup fails", async () => {
    const raw = stream("raw");
    const context = {
      closes: 0,
      createMediaStreamSource: () => ({ disconnect() {} }),
      createGain() { throw new Error("gain unavailable"); },
      async close() { this.closes += 1; }
    };

    assert.throws(() => createMicrophoneInput(
      raw as unknown as MediaStream,
      100,
      () => context as unknown as AudioContext
    ));
    await Promise.resolve();

    assert.equal(raw.audioTrack.stops, 1);
    assert.equal(context.closes, 1);
  });
});
