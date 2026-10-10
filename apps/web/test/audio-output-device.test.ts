import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  connectAudioOutput,
  releaseUnusedSharedAudioOutput,
  retryBlockedAudioOutputs,
  selectSharedAudioOutputDevice,
  subscribeBlockedAudioOutputs,
  unlockSharedAudioOutput,
  voiceOutputDiagnostics,
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
  const events = new EventTarget();
  class FakeMediaElement {
    async setSinkId(_sinkId: string) {}
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      AudioContext: AudioContextClass,
      HTMLMediaElement: FakeMediaElement,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events)
    }
  });
  return events;
}

function createElement(
  options: {
    play?: () => Promise<void>;
    setSinkId?: (sinkId: string) => Promise<void>;
  } = {}
) {
  let pauses = 0;
  const listeners = new Map<string, Set<() => void>>();
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  const element = {
    muted: false,
    paused: true,
    srcObject: null,
    volume: 1,
    async play() {
      await options.play?.();
      element.paused = false;
      emit("playing");
    },
    pause() {
      pauses += 1;
      element.paused = true;
      emit("pause");
    },
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    emit,
    setSinkId: options.setSinkId ?? (async () => undefined),
    pauseCount() {
      return pauses;
    }
  };
  return element as unknown as Omit<HTMLAudioElement, "paused"> & {
    emit: (type: string) => void;
    pauseCount(): number;
    paused: boolean;
  };
}

function connect(element: HTMLAudioElement, stream: MediaStream, muted: boolean, volume: number) {
  const output = connectAudioOutput(element, stream, { muted, volume });
  activeOutputs.push(output);
  return output;
}

function unlockedContext(options: { rejectSink?: boolean; supportsSink?: boolean } = {}) {
  const sources: Array<{ stream: MediaStream; connected: boolean }> = [];
  const gains: Array<{ value: number }> = [];
  const sinks: string[] = [];
  let context!: FakeAudioContext;
  class FakeAudioContext extends EventTarget {
    state: AudioContextState = "suspended";
    currentTime = 0;
    destination = {};
    setSinkId =
      options.supportsSink === false
        ? undefined
        : async (sinkId: string) => {
            sinks.push(sinkId);
            if (options.rejectSink && sinkId) throw new Error("sink unavailable");
          };
    constructor() {
      super();
      context = this;
    }
    async resume() {
      this.state = "running";
    }
    async close() {}
    createMediaStreamSource(stream: MediaStream) {
      const source = { stream, connected: false };
      sources.push(source);
      return {
        connect() {
          source.connected = true;
        },
        disconnect() {
          source.connected = false;
        }
      };
    }
    createGain() {
      const gain = { value: 1 };
      gains.push(gain);
      return { gain, connect() {}, disconnect() {} };
    }
  }
  const events = installWindow(FakeAudioContext as unknown as new () => AudioContext);
  unlockSharedAudioOutput();
  return { context, sources, gains, sinks, events };
}

describe("hybrid voice audio output", () => {
  it("hears a late bot through the context unlocked an hour earlier when native playback is denied", async () => {
    const routedStreams: MediaStream[] = [];
    const gains: Array<{ value: number }> = [];
    class FakeAudioContext {
      static latest: FakeAudioContext;
      state: AudioContextState = "suspended";
      currentTime = 0;
      destination = {};
      constructor() {
        FakeAudioContext.latest = this;
      }
      async resume() {
        this.state = "running";
      }
      async close() {}
      createMediaStreamSource(stream: MediaStream) {
        return {
          connect() {
            routedStreams.push(stream);
          },
          disconnect() {}
        };
      }
      createGain() {
        const gain = { value: 1 };
        gains.push(gain);
        return { gain, connect() {}, disconnect() {} };
      }
    }
    // Each browser owns its own unlocked context; neither Listener should
    // depend on a subsequent action from the member who summoned the bot.
    for (let listener = 0; listener < 2; listener += 1) {
      installWindow(FakeAudioContext as unknown as new () => AudioContext);
      assert.equal(unlockSharedAudioOutput(), true);
      const friend = createElement();
      const friendOutput = connect(friend, { id: "friend" } as MediaStream, false, 100);
      await friendOutput.ready;
      FakeAudioContext.latest.currentTime = 60 * 60;
      const botStream = { id: "late-bot" } as MediaStream;
      const botElement = createElement({
        play: async () => {
          throw { name: "NotAllowedError" };
        }
      });
      const botOutput = connect(botElement, botStream, false, 50);
      await botOutput.ready;

      assert.equal(routedStreams.at(-1), botStream, "the bot must reach the already unlocked hardware output");
      assert.equal(gains.at(-1)?.value, 0.5, "fallback must honor Listener volume");
      assert.equal(botElement.srcObject, botStream);
      assert.equal(botElement.muted, true, "only one output path may be audible");
      assert.equal(friend.paused, false, "existing conversation must continue");
      assert.equal(voiceOutputDiagnostics().blockedCount, 0);
      botOutput.dispose();
      friendOutput.dispose();
      releaseUnusedSharedAudioOutput();
    }
  });

  it("returns an audible fallback to native output after a user activation without doubling audio", async () => {
    const h = unlockedContext();
    let activated = false;
    const element = createElement({
      play: async () => {
        if (!activated) throw { name: "NotAllowedError" };
      }
    });
    const stream = { id: "bot" } as MediaStream;
    const output = connect(element, stream, false, 100);
    await output.ready;
    assert.equal(h.sources[0].connected, true);
    assert.equal(element.muted, true);
    assert.equal(voiceOutputDiagnostics().blockedCount, 0);

    activated = true;
    h.events.dispatchEvent(new Event("pointerdown"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.sources[0].connected, false);
    assert.equal(element.paused, false);
    assert.equal(element.muted, false);
    assert.equal(element.srcObject, stream);
  });

  it("keeps fallback volume live across normal and boosted levels, and mutes both paths", async () => {
    const h = unlockedContext();
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await output.ready;
    for (const volume of [0, 50, 100, 150, 200]) {
      output.setVolume(false, volume);
      assert.equal(h.gains.at(-1)?.value, volume / 100);
      assert.equal(element.muted, true);
      assert.equal(h.sources.filter((source) => source.connected).length, 1);
    }
    output.setVolume(true, 200);
    assert.equal(h.sources.filter((source) => source.connected).length, 0);
    assert.equal(element.muted, true);
    output.setVolume(false, 50);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.sources.filter((source) => source.connected).length, 1);
    assert.equal(h.gains.at(-1)?.value, 0.5);
    assert.equal(element.muted, true);
    output.dispose();
    assert.equal(h.sources.filter((source) => source.connected).length, 0);
  });

  for (const supportsSink of [true, false]) {
    it(`keeps recovery available when the selected speaker cannot route fallback (sink API: ${supportsSink})`, async () => {
      const h = unlockedContext({ rejectSink: true, supportsSink });
      await selectSharedAudioOutputDevice("speaker-a");
      const element = createElement({
        play: async () => {
          throw { name: "NotAllowedError" };
        }
      });
      const output = connect(element, { id: "bot" } as MediaStream, false, 100);
      await output.ready;
      assert.equal(h.sources.length, 0, "audio must never escape to the default speaker");
      assert.equal(voiceOutputDiagnostics().blockedCount, 1);
      assert.equal(await retryBlockedAudioOutputs(), false);
    });
  }

  it("routes fallback to the selected speaker and rebuilds it when the speaker changes", async () => {
    const h = unlockedContext();
    await selectSharedAudioOutputDevice("speaker-a");
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await output.ready;
    assert.equal(h.sinks.at(-1), "speaker-a");
    assert.equal(h.sources[0].connected, true);
    await selectSharedAudioOutputDevice("speaker-b");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.sinks.at(-1), "speaker-b");
    assert.equal(h.sources[0].connected, false);
    assert.equal(h.sources.filter((source) => source.connected).length, 1);
  });

  it("reports blocking when an audible fallback context suspends, and restores it when resumed", async () => {
    const h = unlockedContext();
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await output.ready;
    h.context.state = "suspended";
    h.context.dispatchEvent(new Event("statechange"));
    assert.equal(h.sources.filter((source) => source.connected).length, 0);
    assert.equal(voiceOutputDiagnostics().blockedCount, 1);
    h.context.state = "running";
    h.context.dispatchEvent(new Event("statechange"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.sources.filter((source) => source.connected).length, 1);
    assert.equal(voiceOutputDiagnostics().blockedCount, 0);
  });

  it("does not create a context when native playback is denied without a voice join unlock", async () => {
    let contexts = 0;
    class FakeAudioContext {
      constructor() {
        contexts += 1;
      }
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await output.ready;
    assert.equal(contexts, 0);
    assert.equal(voiceOutputDiagnostics().blockedCount, 1);
  });

  it("keeps recovery available instead of awaiting a suspended context without activation", async () => {
    const h = unlockedContext();
    h.context.state = "suspended";
    let resumes = 0;
    h.context.resume = () => {
      resumes += 1;
      return new Promise<void>(() => {});
    };
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await output.ready;
    assert.equal(resumes, 0, "fallback must not await a promise that requires another user activation");
    assert.equal(h.sources.length, 0);
    assert.equal(voiceOutputDiagnostics().blockedCount, 1);
  });

  it("does not revive a disposed output when fallback sink application finishes late", async () => {
    const h = unlockedContext();
    await selectSharedAudioOutputDevice("speaker-a");
    let finishSink!: () => void;
    h.context.setSinkId = () =>
      new Promise<void>((resolve) => {
        finishSink = resolve;
      });
    const element = createElement({
      play: async () => {
        throw { name: "NotAllowedError" };
      }
    });
    const output = connect(element, { id: "bot" } as MediaStream, false, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(typeof finishSink, "function");
    output.dispose();
    finishSink();
    await output.ready;
    assert.equal(h.sources.length, 0);
    assert.equal(element.srcObject, null);
    assert.equal(voiceOutputDiagnostics().blockedCount, 0);
  });

  it("plays the original stream directly through 100 percent", async () => {
    installWindow();
    const events: string[] = [];
    const stream = { id: "remote" } as MediaStream;
    await selectSharedAudioOutputDevice("speaker-a");
    const element = createElement({
      setSinkId: async (sinkId) => {
        events.push(`sink:${sinkId}`);
      },
      play: async () => {
        events.push("play");
      }
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
    const element = createElement({
      play: async () => {
        plays += 1;
      }
    });
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
        return (gainNode = {
          connect(target: unknown) {
            assert.equal(target, hardwareDestination);
            connections.push("gain:destination");
          },
          disconnect() {},
          gain
        });
      }
      async resume() {
        events.push("resume");
        this.state = "running";
      }
      async close() {}
    }
    let gainNode: { connect(target: unknown): void; disconnect(): void; gain: { value: number } };
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement({
      play: async () => {
        events.push(`play:${(element.srcObject as MediaStream)?.id}`);
      }
    });

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

  it("smooths rapid boosted volume updates without rebuilding playback", async () => {
    const stream = { id: "remote" } as MediaStream;
    const ramps: Array<{ from: number; to: number; at: number }> = [];
    let sourceCreates = 0;
    let plays = 0;
    let currentTime = 4;
    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      get currentTime() {
        return currentTime;
      }
      createMediaStreamSource() {
        sourceCreates += 1;
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        const gain = {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime(value: number) {
            gain.value = value;
          },
          linearRampToValueAtTime(value: number, at: number) {
            ramps.push({ from: gain.value, to: value, at });
            gain.value = value;
          }
        };
        return { connect() {}, disconnect() {}, gain };
      }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    const element = createElement({
      play: async () => {
        plays += 1;
      }
    });
    let srcObject = element.srcObject;
    let srcObjectWrites = 0;
    Object.defineProperty(element, "srcObject", {
      configurable: true,
      get: () => srcObject,
      set: (value) => {
        srcObject = value;
        srcObjectWrites += 1;
      }
    });
    const output = connect(element, stream, false, 125);
    await output.ready;
    srcObjectWrites = 0;

    currentTime = 5;
    output.setVolume(false, 150);
    currentTime = 6;
    output.setVolume(false, 180);

    assert.equal(sourceCreates, 1);
    assert.equal(plays, 1);
    assert.equal(srcObjectWrites, 0);
    assert.equal(element.srcObject, stream);
    assert.equal(element.muted, true);
    assert.deepEqual(
      ramps.slice(-2).map(({ to, at }) => ({ to, at })),
      [
        { to: 1.5, at: 5.025 },
        { to: 1.8, at: 6.025 }
      ]
    );
  });

  it("keeps direct 100 percent playback when boost setup fails", async () => {
    const stream = { id: "remote" } as MediaStream;
    class FailingAudioContext {
      state: AudioContextState = "suspended";
      async resume() {
        throw new Error("resume failed");
      }
      async close() {}
    }
    installWindow(FailingAudioContext as unknown as new () => AudioContext);
    let plays = 0;
    const element = createElement({
      play: async () => {
        plays += 1;
      }
    });

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
        return {
          connect() {},
          disconnect() {
            sourceDisconnects += 1;
          }
        };
      }
      createGain() {
        return {
          connect() {},
          disconnect() {
            gainDisconnects += 1;
          },
          gain: { value: 1 }
        };
      }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    let plays = 0;
    const element = createElement({
      play: async () => {
        plays += 1;
      }
    });

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
      constructor() {
        context = this;
      }
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") stateListener = listener;
      }
      createMediaStreamSource() {
        return {
          connect() {},
          disconnect() {
            sourceDisconnects += 1;
          }
        };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
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
      async setSinkId(sinkId: string) {
        contextSinks.push(sinkId);
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
      async resume() {}
      async close() {}
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);
    await selectSharedAudioOutputDevice("speaker-c");
    const elementSinks: string[] = [];
    const element = createElement({
      setSinkId: async (sinkId) => {
        elementSinks.push(sinkId);
      }
    });

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
      createGain() {
        return { connect() {}, disconnect() {}, gain: { value: 1 } };
      }
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

  it("starts a late Music bot output when media becomes playable without rejoining", async () => {
    installWindow();
    let playable = false;
    let attempts = 0;
    const element = createElement({
      play: async () => {
        attempts += 1;
        if (!playable) throw { name: "AbortError" };
      }
    });
    const stream = { id: "late-music-bot" } as MediaStream;
    const output = connect(element, stream, false, 100);
    await output.ready;
    assert.equal(element.paused, true);

    playable = true;
    element.emit("canplay");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(element.paused, false, "the Listener must hear the bot without a pause/resume or rejoin");
    assert.equal(element.srcObject, stream);
    assert.equal(attempts, 2);
  });

  for (const activation of ["pointerdown", "keydown"]) {
    it(`retries a late blocked Music bot output on ${activation}`, async () => {
      const events = installWindow();
      let activated = false;
      const element = createElement({
        play: async () => {
          if (!activated) throw { name: "NotAllowedError" };
        }
      });
      const output = connect(element, { id: "late-music-bot" } as MediaStream, false, 100);
      await output.ready;
      assert.equal(element.paused, true);

      activated = true;
      events.dispatchEvent(new Event(activation));
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(element.paused, false, "a normal interaction must unlock the new output");
    });
  }

  it("recovers multiple late outputs independently as each becomes playable", async () => {
    installWindow();
    let playable = false;
    const elements = [
      createElement({
        play: async () => {
          if (!playable) throw { name: "AbortError" };
        }
      }),
      createElement({
        play: async () => {
          if (!playable) throw { name: "AbortError" };
        }
      })
    ];
    const outputs = elements.map((element) => connect(element, { id: "bot" } as MediaStream, false, 100));
    await Promise.all(outputs.map((output) => output.ready));
    playable = true;

    elements[0].emit("canplay");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(elements[0].paused, false);
    assert.equal(elements[1].paused, true);
    elements[1].emit("canplay");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(elements[1].paused, false);
  });

  it("does not restart healthy audio on readiness events or user activation", async () => {
    const events = installWindow();
    let attempts = 0;
    const element = createElement({
      play: async () => {
        attempts += 1;
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    await output.ready;
    element.emit("canplay");
    events.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    assert.equal(attempts, 1);
  });

  it("keeps readiness and activation retries single-flight", async () => {
    const events = installWindow();
    let attempts = 0;
    let resolvePlay!: () => void;
    const pendingPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    const element = createElement({
      play: async () => {
        attempts += 1;
        if (attempts === 1) throw { name: "NotAllowedError" };
        await pendingPlay;
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    await output.ready;
    events.dispatchEvent(new Event("pointerdown"));
    element.emit("canplay");
    events.dispatchEvent(new Event("keydown"));
    const retry = output.retry();
    assert.equal(attempts, 2);
    resolvePlay();
    assert.equal(await retry, true);
  });

  it("waits for the selected speaker before a readiness retry can play", async () => {
    installWindow();
    await selectSharedAudioOutputDevice("speaker-late");
    let applySink!: () => void;
    const sinkPending = new Promise<void>((resolve) => {
      applySink = resolve;
    });
    let attempts = 0;
    const element = createElement({
      setSinkId: () => sinkPending,
      play: async () => {
        attempts += 1;
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    element.emit("canplay");
    assert.equal(await output.retry(), false);
    assert.equal(attempts, 0, "audio must not escape to the default speaker");
    applySink();
    await output.ready;
    assert.equal(attempts, 1);
  });

  it("ignores a play rejection and readiness events after output disposal", async () => {
    const events = installWindow();
    let rejectPlay!: (cause: unknown) => void;
    let attempts = 0;
    const pendingPlay = new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    const blockedStates: boolean[] = [];
    const unsubscribe = subscribeBlockedAudioOutputs((blocked) => blockedStates.push(blocked));
    const element = createElement({
      play: () => {
        attempts += 1;
        return pendingPlay;
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    // Allow sink application to finish and the first play to start.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
    output.dispose();
    rejectPlay({ name: "AbortError" });
    await output.ready;
    element.emit("canplay");
    events.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    assert.equal(attempts, 1);
    assert.equal(element.srcObject, null);
    assert.equal(blockedStates.at(-1), false);
    assert.equal(await retryBlockedAudioOutputs(), true);
    unsubscribe();
  });

  it("retries playback if a previously playing remote output pauses", async () => {
    installWindow();
    let attempts = 0;
    const element = createElement({
      play: async () => {
        attempts += 1;
      }
    });
    const output = connect(element, { id: "remote" } as MediaStream, false, 100);
    await output.ready;

    element.paused = true;
    element.emit("pause");
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(attempts, 2);
    assert.equal(element.paused, false);
  });

  it("routes a speaker change to active and future native elements", async () => {
    installWindow();
    const firstSinks: string[] = [];
    const secondSinks: string[] = [];
    const first = createElement({
      setSinkId: async (sinkId) => {
        firstSinks.push(sinkId);
      }
    });
    const firstOutput = connect(first, { id: "first" } as MediaStream, false, 100);
    await firstOutput.ready;

    assert.equal(await selectSharedAudioOutputDevice("speaker-b"), "media-elements");
    const second = createElement({
      setSinkId: async (sinkId) => {
        secondSinks.push(sinkId);
      }
    });
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
      getTracks: () => [
        {
          stop: () => {
            stopped += 1;
          }
        }
      ]
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
      resume() {
        resumes += 1;
        this.state = "running";
        return Promise.resolve();
      }
      close() {
        closes += 1;
        return Promise.resolve();
      }
    }
    installWindow(FakeAudioContext as unknown as new () => AudioContext);

    assert.equal(unlockSharedAudioOutput(), true);
    assert.equal(resumes, 1);
    assert.equal(releaseUnusedSharedAudioOutput(), true);
    assert.equal(closes, 1);
  });
});
