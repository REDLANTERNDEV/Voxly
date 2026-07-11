import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  applySharedAudioOutputToMediaElement,
  connectAudioOutput,
  selectSharedAudioOutputDevice,
  sharedAudioOutputSelectionSupported
} from "../src/lib/audioOutput.js";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("shared audio output device", () => {
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
});
