import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMicrophoneInput } from "../src/lib/microphoneInput.js";
import {
  noiseGateBypassHz,
  noiseGateClosedGain,
  noiseGateHighPassHz,
  noiseGateOpenGain
} from "../src/lib/noiseGate.js";

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
  function audioParam(value: number) {
    return {
      value,
      targets: [] as Array<{ value: number; timeConstant: number }>,
      setTargetAtTime(next: number, _when: number, timeConstant: number) {
        this.targets.push({ value: next, timeConstant });
        this.value = next;
      }
    };
  }
  const highPassConnections: unknown[] = [];
  const gateConnections: unknown[] = [];
  const highPass = {
    type: "",
    Q: audioParam(1),
    frequency: audioParam(0),
    disconnects: 0,
    connect(node: unknown) { highPassConnections.push(node); },
    disconnect() { this.disconnects += 1; }
  };
  const analyser = {
    fftSize: 0,
    reads: 0,
    disconnects: 0,
    getFloatTimeDomainData(target: Float32Array) { this.reads += 1; target.fill(0); },
    disconnect() { this.disconnects += 1; }
  };
  const gate = {
    gain: audioParam(1),
    disconnects: 0,
    connect(node: unknown) { gateConnections.push(node); },
    disconnect() { this.disconnects += 1; }
  };
  const gain = {
    gain: { value: 1 },
    disconnects: 0,
    connect(node: unknown) { gainConnections.push(node); },
    disconnect() { this.disconnects += 1; }
  };
  const gains = [gate, gain];
  const destinations = [{ stream: voice }, { stream: monitor }];
  const context = {
    closes: 0,
    resumes: 0,
    currentTime: 0,
    createMediaStreamSource(received: unknown) {
      assert.equal(received, raw);
      return source;
    },
    createBiquadFilter: () => highPass,
    createAnalyser: () => analyser,
    createGain: () => gains.shift(),
    createMediaStreamDestination: () => destinations.shift(),
    async resume() { this.resumes += 1; },
    async close() { this.closes += 1; }
  };
  const ticks: Array<() => void> = [];
  return {
    analyser, context, gain, gainConnections, gate, gateConnections, highPass, highPassConnections,
    monitor, raw, source, sourceConnections, ticks, voice,
    options: {
      createContext: () => context as unknown as AudioContext,
      setInterval: (handler: () => void) => { ticks.push(handler); return ticks.length; },
      clearInterval: () => undefined
    }
  };
}

describe("microphone input processing", () => {
  it("feeds voice and monitor streams through one shared input gain", () => {
    const graph = audioGraph();
    const input = createMicrophoneInput(
      graph.raw as unknown as MediaStream,
      135,
      graph.options
    );

    assert.equal(input.voiceStream, graph.voice);
    assert.equal(input.monitorStream, graph.monitor);
    assert.equal(input.analyser, graph.analyser);
    assert.deepEqual(graph.sourceConnections, [graph.highPass]);
    assert.deepEqual(graph.highPassConnections, [graph.analyser, graph.gate], "the expander measures the filtered signal before its own gain");
    assert.deepEqual(graph.gateConnections, [graph.gain]);
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
      graph.options
    );

    input.dispose();
    input.dispose();

    assert.equal(graph.raw.audioTrack.stops, 1);
    assert.equal(graph.voice.audioTrack.stops, 1);
    assert.equal(graph.monitor.audioTrack.stops, 1);
    assert.equal(graph.source.disconnects, 1);
    assert.equal(graph.highPass.disconnects, 1);
    assert.equal(graph.analyser.disconnects, 1);
    assert.equal(graph.gate.disconnects, 1);
    assert.equal(graph.gain.disconnects, 1);
    assert.equal(graph.context.closes, 1);
  });

  it("stops the raw capture when an audio graph cannot be created", () => {
    const raw = stream("raw");

    assert.throws(() => createMicrophoneInput(
      raw as unknown as MediaStream,
      100,
      { createContext: () => { throw new Error("unavailable"); } }
    ));
    assert.equal(raw.audioTrack.stops, 1);
  });

  it("closes a partially created audio context when graph setup fails", async () => {
    const raw = stream("raw");
    const context = {
      closes: 0,
      createMediaStreamSource: () => ({ disconnect() {}, connect() {} }),
      createBiquadFilter: () => ({ type: "", Q: { value: 1 }, frequency: { value: 0 }, disconnect() {}, connect() {} }),
      createAnalyser: () => ({ fftSize: 0, disconnect() {}, connect() {} }),
      createGain() { throw new Error("gain unavailable"); },
      async close() { this.closes += 1; }
    };

    assert.throws(() => createMicrophoneInput(
      raw as unknown as MediaStream,
      100,
      { createContext: () => context as unknown as AudioContext }
    ));
    await Promise.resolve();

    assert.equal(raw.audioTrack.stops, 1);
    assert.equal(context.closes, 1);
  });
});

describe("capture-graph noise suppression", () => {
  it("keeps the extra filter off when no preference is supplied", () => {
    const graph = audioGraph();
    createMicrophoneInput(graph.raw as unknown as MediaStream, 100, graph.options);

    for (let tick = 0; tick < 40; tick += 1) graph.ticks[0]();

    assert.equal(graph.highPass.frequency.value, noiseGateBypassHz);
    assert.equal(graph.gate.gain.value, noiseGateOpenGain);
  });

  it("applies the preference to the graph rather than reopening the device", () => {
    const graph = audioGraph();
    const input = createMicrophoneInput(graph.raw as unknown as MediaStream, 100, {
      ...graph.options,
      noiseSuppression: true
    });

    assert.equal(graph.highPass.type, "highpass");
    assert.equal(graph.highPass.frequency.value, noiseGateHighPassHz);

    input.setNoiseSuppression(false);
    assert.equal(graph.highPass.frequency.value, noiseGateBypassHz, "the filter is bypassed rather than unwired");
    assert.equal(graph.gate.gain.value, noiseGateOpenGain, "the expander is held open rather than removed");

    input.setNoiseSuppression(true);
    assert.equal(graph.highPass.frequency.value, noiseGateHighPassHz);
    assert.equal(graph.raw.audioTrack.stops, 0, "the capture is never disturbed by the preference");
  });

  it("ducks to a floor rather than to silence once the room is measured", () => {
    const graph = audioGraph();
    createMicrophoneInput(graph.raw as unknown as MediaStream, 100, {
      ...graph.options,
      noiseSuppression: true
    });

    // The fake analyser reports silence, so the gate closes.
    for (let tick = 0; tick < 40; tick += 1) graph.ticks[0]();

    assert.equal(graph.gate.gain.value, noiseGateClosedGain);
    assert.ok(noiseGateClosedGain > 0, "a gate that closes to zero chops the room in and out");
  });

  it("ramps the expander instead of stepping it, so the gate itself cannot click", () => {
    const graph = audioGraph();
    createMicrophoneInput(graph.raw as unknown as MediaStream, 100, {
      ...graph.options,
      noiseSuppression: true
    });

    for (let tick = 0; tick < 40; tick += 1) graph.ticks[0]();

    assert.ok(graph.gate.gain.targets.length > 0, "every change is scheduled, never assigned");
    assert.ok(graph.gate.gain.targets.every((target) => target.timeConstant > 0));
  });

  it("holds the expander open while the preference is off", () => {
    const graph = audioGraph();
    createMicrophoneInput(graph.raw as unknown as MediaStream, 100, {
      ...graph.options,
      noiseSuppression: false
    });

    for (let tick = 0; tick < 40; tick += 1) graph.ticks[0]();

    assert.equal(graph.gate.gain.value, noiseGateOpenGain);
  });

  it("stops measuring once disposed", () => {
    const graph = audioGraph();
    const input = createMicrophoneInput(graph.raw as unknown as MediaStream, 100, graph.options);

    graph.ticks[0]();
    const readsBeforeDispose = graph.analyser.reads;
    input.dispose();
    graph.ticks[0]();

    assert.equal(graph.analyser.reads, readsBeforeDispose);
  });
});

describe("optional worklet handoff", () => {
  for (const failure of ["input", "output", "module", "constructor", "message", "none"] as const) {
    it(`preserves a working graph and cleans up when worklet outcome is ${failure}`, async () => {
      const graph = audioGraph();
      const edges = new Set<unknown>([]);
      graph.highPass.connect = (node) => {
        if (failure === "input" && node instanceof FakeWorklet) throw new Error("input connection failed");
        edges.add(node);
      };
      graph.highPass.disconnect = ((node?: unknown) => {
        if (node) edges.delete(node);
        else edges.clear();
      }) as typeof graph.highPass.disconnect;
      const nodes: FakeWorklet[] = [];
      class FakeWorklet {
        connected = false;
        port = { postMessage() { if (failure === "message") throw new Error("message failed"); }, close() {} };
        constructor() { if (failure === "constructor") throw new Error("construction failed"); nodes.push(this); }
        connect() {
          if (failure === "output") throw new Error("output connection failed");
          this.connected = true;
        }
        disconnect() { this.connected = false; }
      }
      const previous = globalThis.AudioWorkletNode;
      globalThis.AudioWorkletNode = FakeWorklet as unknown as typeof AudioWorkletNode;
      const context = Object.assign(graph.context, { audioWorklet: {
        async addModule() { if (failure === "module") throw new Error("module failed"); }
      } });
      let input: ReturnType<typeof createMicrophoneInput> | undefined;
      try {
        input = createMicrophoneInput(graph.raw as unknown as MediaStream, 100, {
          ...graph.options, createContext: () => context as unknown as AudioContext
        });
        assert.ok(edges.has(graph.gate));
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failure === "none") {
          assert.ok(!edges.has(graph.gate), "successful handoff removes parallel fallback");
          assert.ok(edges.has(nodes[0]) && nodes[0].connected);
        } else {
          assert.ok(edges.has(graph.gate), "failed optional setup preserves live microphone audio");
          assert.ok(nodes.every((node) => !edges.has(node) && !node.connected), "no partial worklet route survives");
        }
        assert.equal(graph.raw.audioTrack.stops, 0);
      } finally {
        input?.dispose();
        globalThis.AudioWorkletNode = previous;
      }
      assert.equal(graph.raw.audioTrack.stops, 1);
      assert.equal(edges.size, 0);
    });
  }
});
