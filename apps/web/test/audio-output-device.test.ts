import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  applySharedAudioOutputToMediaElement,
  connectAudioOutput,
  selectSharedAudioOutputDevice,
  sharedAudioOutputSelectionSupported
} from "../src/lib/audioOutput.js";
import * as audioOutputModule from "../src/lib/audioOutput.js";

const originalWindow = globalThis.window;

afterEach(() => {
  const release = (audioOutputModule as Record<string, unknown>).releaseUnusedSharedAudioOutput as (() => boolean) | undefined;
  release?.();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("shared audio output device", () => {
  it("unlocks one shared audio context before a remote stream arrives", () => {
    let contexts = 0;
    let resumes = 0;
    class FakeAudioContext {
      destination = {};
      constructor() { contexts += 1; }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
      resume() { resumes += 1; return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {}
      }
    });
    const unlockSharedAudioOutput = (audioOutputModule as Record<string, unknown>).unlockSharedAudioOutput;

    assert.equal(typeof unlockSharedAudioOutput, "function");
    (unlockSharedAudioOutput as () => void)();
    assert.equal(contexts, 1);
    assert.equal(resumes, 1);

    const output = connectAudioOutput({} as MediaStream);
    assert.equal(contexts, 1);
    output?.dispose();
  });

  it("keeps an unlocked context across temporary periods without remote outputs", () => {
    let contexts = 0;
    let closes = 0;
    class FakeAudioContext {
      destination = {};
      constructor() { contexts += 1; }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
      resume() { return Promise.resolve(); }
      close() { closes += 1; return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {}
      }
    });
    const unlock = (audioOutputModule as Record<string, unknown>).unlockSharedAudioOutput as () => void;
    const release = (audioOutputModule as Record<string, unknown>).releaseUnusedSharedAudioOutput as () => boolean;

    unlock();
    const firstOutput = connectAudioOutput({} as MediaStream);
    firstOutput?.dispose();
    assert.equal(closes, 0);

    const secondOutput = connectAudioOutput({} as MediaStream);
    assert.equal(contexts, 1);
    secondOutput?.dispose();
    assert.equal(release(), true);
    assert.equal(closes, 1);
  });

  it("releases a pre-unlocked context when no remote output was attached", () => {
    let contexts = 0;
    let closes = 0;
    class FakeAudioContext {
      destination = {};
      constructor() { contexts += 1; }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
      resume() { return Promise.resolve(); }
      close() { closes += 1; return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {}
      }
    });
    const unlock = (audioOutputModule as Record<string, unknown>).unlockSharedAudioOutput as (() => void) | undefined;
    const release = (audioOutputModule as Record<string, unknown>).releaseUnusedSharedAudioOutput as (() => boolean) | undefined;

    assert.equal(typeof unlock, "function");
    assert.equal(typeof release, "function");
    unlock?.();
    assert.equal(release?.(), true);
    assert.equal(closes, 1);

    const output = connectAudioOutput({} as MediaStream);
    assert.equal(contexts, 2);
    output?.dispose();
  });

  it("remembers a selection before playback and applies it when the shared context is created", async () => {
    const sinks: string[] = [];
    class FakeAudioContext {
      destination = {};
      async setSinkId(sinkId: string) { sinks.push(sinkId); }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {}
      }
    });

    assert.equal(sharedAudioOutputSelectionSupported(), true);
    assert.equal(await selectSharedAudioOutputDevice("speaker-a"), "audio-context");
    const output = connectAudioOutput({} as MediaStream);
    await Promise.resolve();

    assert.deepEqual(sinks, ["speaker-a"]);
    output?.dispose();
  });

  it("applies the remembered output to fallback media elements", async () => {
    const sinks: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: undefined, addEventListener() {}, removeEventListener() {} }
    });
    await selectSharedAudioOutputDevice("speaker-b");

    await applySharedAudioOutputToMediaElement({ setSinkId: async (sinkId: string) => { sinks.push(sinkId); } } as HTMLMediaElement);

    assert.deepEqual(sinks, ["speaker-b"]);
  });

  it("applies the initial mute and volume before remote audio starts", () => {
    const gains: Array<{ value: number }> = [];
    class FakeAudioContext {
      destination = {};
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        const gain = { value: 1 };
        gains.push(gain);
        return { connect() {}, disconnect() {}, gain };
      }
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {}
      }
    });

    const connectWithInitialState = connectAudioOutput as unknown as (
      stream: MediaStream,
      initialState: { muted: boolean; volume: number }
    ) => ReturnType<typeof connectAudioOutput>;
    const output = connectWithInitialState({} as MediaStream, { muted: false, volume: 150 });

    assert.equal(gains[0]?.value, 1.5);
    output?.setVolume(true, 200);
    assert.equal(gains[0]?.value, 0);
    output?.dispose();
  });

  it("initializes fallback media elements before playback", async () => {
    let played = 0;
    const stream = {} as MediaStream;
    const element = {
      muted: false,
      volume: 1,
      srcObject: null,
      async play() { played += 1; }
    } as unknown as HTMLAudioElement;
    const initializeFallbackAudioElement = (audioOutputModule as Record<string, unknown>).initializeFallbackAudioElement;

    assert.equal(typeof initializeFallbackAudioElement, "function");
    await (initializeFallbackAudioElement as (
      element: HTMLAudioElement,
      stream: MediaStream,
      state: { muted: boolean; volume: number }
    ) => Promise<void>)(element, stream, { muted: true, volume: 25 });

    assert.equal(element.srcObject, stream);
    assert.equal(element.muted, true);
    assert.equal(element.volume, 0.25);
    assert.equal(played, 1);
  });
});
