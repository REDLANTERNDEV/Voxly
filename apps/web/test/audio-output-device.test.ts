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

  it("starts fail-open at 100 percent before switching one element to boosted audio", async () => {
    const originalStream = { id: "remote" } as MediaStream;
    const processedStream = { id: "processed" } as MediaStream;
    const gains: Array<{ value: number }> = [];
    const events: string[] = [];
    class FakeAudioContext {
      state: AudioContextState = "suspended";
      destination = {};
      createMediaStreamSource(stream: MediaStream) {
        assert.equal(stream, originalStream);
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        const gain = { value: 1 };
        gains.push(gain);
        return { connect() {}, disconnect() {}, gain };
      }
      createMediaStreamDestination() {
        return { stream: processedStream, disconnect() {} };
      }
      async resume() {
        events.push("resume");
        this.state = "running";
      }
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement({ play: async () => { events.push(`play:${(element.srcObject as MediaStream)?.id}`); } });

    const output = connect(element, originalStream, false, 150);
    assert.equal(element.srcObject, originalStream);
    assert.equal(element.volume, 1);
    await output.ready;

    assert.deepEqual(events, ["play:remote", "resume", "play:processed"]);
    assert.equal(element.srcObject, processedStream);
    assert.equal(element.volume, 1);
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

  it("returns to direct playback when the processed stream cannot play", async () => {
    const originalStream = { id: "remote" } as MediaStream;
    const processedStream = { id: "processed" } as MediaStream;
    class FakeAudioContext {
      state: AudioContextState = "running";
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createGain() { return { connect() {}, disconnect() {}, gain: { value: 1 } }; }
      createMediaStreamDestination() { return { stream: processedStream, disconnect() {} }; }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const attempts: string[] = [];
    const element = createElement({
      play: async () => {
        const streamId = (element.srcObject as MediaStream)?.id;
        attempts.push(streamId);
        if (streamId === "processed") throw { name: "NotAllowedError" };
      }
    });

    const output = connect(element, originalStream, false, 150);
    await output.ready;

    assert.deepEqual(attempts, ["remote", "processed", "remote"]);
    assert.equal(element.srcObject, originalStream);
    assert.equal(element.volume, 1);
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
