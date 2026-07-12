import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  connectAudioOutput,
  releaseUnusedSharedAudioOutput,
  retryBlockedAudioOutputs,
  selectSharedAudioOutputDevice,
  subscribeBlockedAudioOutputs,
  unlockSharedAudioOutput,
  type AudioOutput
} from "../src/lib/audioOutput.js";

const originalWindow = globalThis.window;
const activeOutputs: AudioOutput[] = [];

afterEach(async () => {
  for (const output of activeOutputs.splice(0)) output.dispose();
  releaseUnusedSharedAudioOutput();
  await selectSharedAudioOutputDevice("");
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function installWindow(AudioContextClass?: new () => AudioContext) {
  class FakeMediaElement {
    async setSinkId(_sinkId: string) {}
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      AudioContext: AudioContextClass,
      HTMLMediaElement: FakeMediaElement,
      addEventListener() {},
      removeEventListener() {}
    }
  });
}

function createElement(options: {
  play?: () => Promise<void>;
  setSinkId?: (sinkId: string) => Promise<void>;
} = {}) {
  let pauses = 0;
  const element = {
    muted: false,
    paused: true,
    srcObject: null,
    volume: 1,
    async play() {
      await options.play?.();
      element.paused = false;
    },
    pause() {
      pauses += 1;
      element.paused = true;
    },
    setSinkId: options.setSinkId ?? (async () => undefined),
    pauseCount() { return pauses; }
  };
  return element as unknown as HTMLAudioElement & { pauseCount(): number };
}

function connect(element: HTMLAudioElement, stream: MediaStream, muted: boolean, volume: number) {
  const output = connectAudioOutput(element, stream, { muted, volume });
  activeOutputs.push(output);
  return output;
}

describe("hybrid voice audio output", () => {
  it("plays the original stream directly through 100 percent", async () => {
    installWindow();
    const events: string[] = [];
    const stream = { id: "remote" } as MediaStream;
    await selectSharedAudioOutputDevice("speaker-a");
    const element = createElement({
      setSinkId: async (sinkId) => { events.push(`sink:${sinkId}`); },
      play: async () => { events.push("play"); }
    });

    const output = connect(element, stream, false, 50);
    await output.ready;

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 0.5);
    assert.equal(element.muted, false);
    assert.deepEqual(events, ["sink:speaker-a", "play"]);
  });

  it("updates direct volume without restarting an already playing stream", async () => {
    installWindow();
    let plays = 0;
    const stream = { id: "remote" } as MediaStream;
    const element = createElement({ play: async () => { plays += 1; } });
    const output = connect(element, stream, false, 100);
    await output.ready;

    output.setVolume(false, 50);
    await Promise.resolve();

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 0.5);
    assert.equal(plays, 1);
  });

  it("boosts directly to the context destination while the native stream stays current", async () => {
    const originalStream = { id: "remote" } as MediaStream;
    const gains: Array<{ value: number }> = [];
    const events: string[] = [];
    const hardwareDestination = { id: "hardware" };
    const connections: string[] = [];
    class FakeAudioContext {
      state: AudioContextState = "suspended";
      destination = hardwareDestination;
      createMediaStreamSource(stream: MediaStream) {
        assert.equal(stream, originalStream);
        return {
          connect(target: unknown) {
            assert.equal(target, gainNode);
            connections.push("source:gain");
          },
          disconnect() {}
        };
      }
      createGain() {
        const gain = { value: 1 };
        gains.push(gain);
        return gainNode = {
          connect(target: unknown) {
            assert.equal(target, hardwareDestination);
            connections.push("gain:destination");
          },
          disconnect() {},
          gain
        };
      }
      async resume() {
        events.push("resume");
        this.state = "running";
      }
      async close() {}
    }
    let gainNode: { connect(target: unknown): void; disconnect(): void; gain: { value: number } };
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement({ play: async () => { events.push(`play:${(element.srcObject as MediaStream)?.id}`); } });

    const output = connect(element, originalStream, false, 150);
    assert.equal(element.srcObject, originalStream);
    assert.equal(element.volume, 1);
    await output.ready;

    assert.deepEqual(events, ["play:remote", "resume"]);
    assert.deepEqual(connections, ["source:gain", "gain:destination"]);
    assert.equal(element.srcObject, originalStream);
    assert.equal(element.volume, 1);
    assert.equal(element.muted, true);
    assert.equal(gains[0]?.value, 1.5);
  });

  it("keeps direct 100 percent playback when boost setup fails", async () => {
    const stream = { id: "remote" } as MediaStream;
    class FailingAudioContext {
      state: AudioContextState = "suspended";
      async resume() { throw new Error("resume failed"); }
      async close() {}
    }
    installWindow(FailingAudioContext as unknown as new () => AudioContext);
    let plays = 0;
    const element = createElement({ play: async () => { plays += 1; } });

    const output = connect(element, stream, false, 175);
    await output.ready;

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 1);
    assert.equal(plays, 1);
  });

  it("returns from boost without replacing or restarting the live native stream", async () => {
    const stream = { id: "remote" } as MediaStream;
    let sourceDisconnects = 0;
    let gainDisconnects = 0;
    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() { sourceDisconnects += 1; } };
      }
      createGain() {
        return { connect() {}, disconnect() { gainDisconnects += 1; }, gain: { value: 1 } };
      }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    let plays = 0;
    const element = createElement({ play: async () => { plays += 1; } });

    const output = connect(element, stream, false, 150);
    await output.ready;
    assert.equal(element.muted, true);

    output.setVolume(false, 100);
    await Promise.resolve();

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 1);
    assert.equal(element.muted, false);
    assert.equal(plays, 1);
    assert.equal(sourceDisconnects, 1);
    assert.equal(gainDisconnects, 1);
  });

  it("fails open to current native playback when the boost context is suspended", async () => {
    const stream = { id: "remote" } as MediaStream;
    let context: FakeAudioContext;
    let stateListener: (() => void) | undefined;
    let sourceDisconnects = 0;
    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      constructor() { context = this; }
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") stateListener = listener;
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() { sourceDisconnects += 1; } };
      }
      createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement();
    const output = connect(element, stream, false, 150);
    await output.ready;
    assert.equal(element.muted, true);

    context!.state = "suspended";
    stateListener?.();
    await Promise.resolve();

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 1);
    assert.equal(element.muted, false);
    assert.equal(sourceDisconnects, 1);
  });

  it("routes boost to the selected speaker before muting native playback", async () => {
    const contextSinks: string[] = [];
    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      async setSinkId(sinkId: string) { contextSinks.push(sinkId); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    await selectSharedAudioOutputDevice("speaker-c");
    const elementSinks: string[] = [];
    const element = createElement({ setSinkId: async (sinkId) => { elementSinks.push(sinkId); } });

    const output = connect(element, { id: "remote" } as MediaStream, false, 150);
    await output.ready;

    assert.deepEqual(elementSinks, ["speaker-c"]);
    assert.deepEqual(contextSinks, ["speaker-c"]);
    assert.equal(element.muted, true);
  });

  it("keeps native 100 percent audible when a selected speaker cannot route boost", async () => {
    let sources = 0;
    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      createMediaStreamSource() {
        sources += 1;
        return { connect() {}, disconnect() {} };
      }
      createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    await selectSharedAudioOutputDevice("speaker-d");
    const stream = { id: "remote" } as MediaStream;
    const element = createElement();

    const output = connect(element, stream, false, 180);
    await output.ready;

    assert.equal(element.srcObject, stream);
    assert.equal(element.volume, 1);
    assert.equal(element.muted, false);
    assert.equal(sources, 0);
  });

  it("reports autoplay denial and clears it after a user retry", async () => {
    installWindow();
    let attempts = 0;
    const blockedStates: boolean[] = [];
    const unsubscribe = subscribeBlockedAudioOutputs((blocked) => blockedStates.push(blocked));
    const element = createElement({
      play: async () => {
        attempts += 1;
        if (attempts === 1) throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    await output.ready;

    assert.equal(blockedStates.at(-1), true);
    assert.equal(await retryBlockedAudioOutputs(), true);
    assert.equal(attempts, 2);
    assert.equal(blockedStates.at(-1), false);
    unsubscribe();
  });

  it("routes a speaker change to active and future native elements", async () => {
    installWindow();
    const firstSinks: string[] = [];
    const secondSinks: string[] = [];
    const first = createElement({ setSinkId: async (sinkId) => { firstSinks.push(sinkId); } });
    const firstOutput = connect(first, { id: "first" } as MediaStream, false, 100);
    await firstOutput.ready;

    assert.equal(await selectSharedAudioOutputDevice("speaker-b"), "media-elements");
    const second = createElement({ setSinkId: async (sinkId) => { secondSinks.push(sinkId); } });
    const secondOutput = connect(second, { id: "second" } as MediaStream, false, 100);
    await secondOutput.ready;

    assert.deepEqual(firstSinks, ["", "speaker-b"]);
    assert.deepEqual(secondSinks, ["speaker-b"]);
  });

  it("cleans up without stopping receiver-owned tracks", async () => {
    installWindow();
    let stopped = 0;
    const stream = {
      id: "remote",
      getTracks: () => [{ stop: () => { stopped += 1; } }]
    } as unknown as MediaStream;
    const element = createElement();
    const output = connect(element, stream, false, 100);
    await output.ready;

    output.dispose();
    output.dispose();

    assert.equal(element.srcObject, null);
    assert.equal(element.pauseCount(), 1);
    assert.equal(stopped, 0);
  });

  it("pre-unlocks and releases the shared boost context around a voice session", () => {
    let resumes = 0;
    let closes = 0;
    class FakeAudioContext {
      state: AudioContextState = "suspended";
      resume() { resumes += 1; this.state = "running"; return Promise.resolve(); }
      close() { closes += 1; return Promise.resolve(); }
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);

    assert.equal(unlockSharedAudioOutput(), true);
    assert.equal(resumes, 1);
    assert.equal(releaseUnusedSharedAudioOutput(), true);
    assert.equal(closes, 1);
  });
});
