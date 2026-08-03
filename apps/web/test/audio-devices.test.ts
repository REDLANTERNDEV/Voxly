import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  applyAudioOutputDevice,
  audioDeviceDisplayName,
  audioDevicePreferenceKey,
  buildMicrophoneConstraints,
  enumerateAudioDevices,
  readAudioDevicePreference,
  reconcileAudioDevicePreference,
  subscribeToAudioDeviceChanges,
  supportsAudioOutputSelection,
  writeAudioDevicePreference
} from "../src/lib/audioDevices.js";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function device(deviceId: string, kind: MediaDeviceKind, label = deviceId): MediaDeviceInfo {
  return { deviceId, groupId: "group", kind, label, toJSON: () => ({}) };
}

describe("audio device preferences", () => {
  it("isolates input and output preferences by user", () => {
    const storage = new MemoryStorage();

    writeAudioDevicePreference(storage, "user-a", "input", "mic-a");
    writeAudioDevicePreference(storage, "user-a", "output", "speaker-a");
    writeAudioDevicePreference(storage, "user-b", "input", "mic-b");

    assert.equal(audioDevicePreferenceKey("user-a", "input"), "voxly:audio-device:user-a:input");
    assert.equal(readAudioDevicePreference(storage, "user-a", "input"), "mic-a");
    assert.equal(readAudioDevicePreference(storage, "user-a", "output"), "speaker-a");
    assert.equal(readAudioDevicePreference(storage, "user-b", "input"), "mic-b");
  });

  it("clears a preference when system default is selected", () => {
    const storage = new MemoryStorage();
    writeAudioDevicePreference(storage, "user-a", "input", "mic-a");

    writeAudioDevicePreference(storage, "user-a", "input", "");

    assert.equal(readAudioDevicePreference(storage, "user-a", "input"), "");
    assert.equal(storage.getItem(audioDevicePreferenceKey("user-a", "input")), null);
  });
});

describe("audio device discovery", () => {
  it("requests microphone permission before enumerating and stops the permission stream", async () => {
    const events: string[] = [];
    let stopped = false;
    const mediaDevices = {
      async getUserMedia() {
        events.push("permission");
        return { getTracks: () => [{ stop: () => { stopped = true; } }] } as unknown as MediaStream;
      },
      async enumerateDevices() {
        events.push("enumerate");
        return [device("mic", "audioinput"), device("speaker", "audiooutput"), device("cam", "videoinput")];
      }
    };

    const result = await enumerateAudioDevices(mediaDevices, { requestPermission: true });

    assert.deepEqual(events, ["permission", "enumerate"]);
    assert.equal(stopped, true);
    assert.deepEqual(result.inputs.map(({ deviceId }) => deviceId), ["mic"]);
    assert.deepEqual(result.outputs.map(({ deviceId }) => deviceId), ["speaker"]);
  });

  it("falls back to system default when a selected device disappears", () => {
    assert.equal(reconcileAudioDevicePreference("mic-a", [device("mic-a", "audioinput")]), "mic-a");
    assert.equal(reconcileAudioDevicePreference("missing", [device("mic-a", "audioinput")]), "");
    assert.equal(reconcileAudioDevicePreference("", [device("mic-a", "audioinput")]), "");
  });

  it("refreshes when the browser reports a device change and unsubscribes cleanly", () => {
    let handler: (() => void) | undefined;
    let calls = 0;
    const mediaDevices = {
      addEventListener(type: string, next: () => void) {
        assert.equal(type, "devicechange");
        handler = next;
      },
      removeEventListener(type: string, next: () => void) {
        assert.equal(type, "devicechange");
        assert.equal(next, handler);
        handler = undefined;
      }
    };

    const unsubscribe = subscribeToAudioDeviceChanges(mediaDevices, () => { calls += 1; });
    handler?.();
    unsubscribe();

    assert.equal(calls, 1);
    assert.equal(handler, undefined);
  });

  it("shows browser device names and uses human labels only when a name is unavailable", () => {
    assert.equal(audioDeviceDisplayName(device("mic-a", "audioinput", "MacBook Pro Microphone"), "Microphone", 0), "MacBook Pro Microphone");
    assert.equal(audioDeviceDisplayName(device("mic-b", "audioinput", ""), "Microphone", 1), "Microphone 2");
    assert.equal(audioDeviceDisplayName(device("speaker-a", "audiooutput", ""), "Audio output", 0), "Audio output 1");
  });
});

describe("audio device application", () => {
  it("builds exact microphone constraints only for an explicit device", () => {
    assert.deepEqual(buildMicrophoneConstraints(""), { audio: true, video: false });
    assert.deepEqual(buildMicrophoneConstraints("mic-a"), {
      audio: { deviceId: { exact: "mic-a" } },
      video: false
    });
  });

  it("adds noise suppression only when the caller requests it", () => {
    // Omitting the option must stay byte-identical to a capture built before
    // the preference existed.
    assert.deepEqual(buildMicrophoneConstraints("mic-a", {}), buildMicrophoneConstraints("mic-a"));
    assert.deepEqual(buildMicrophoneConstraints("", {}), buildMicrophoneConstraints(""));

    assert.deepEqual(buildMicrophoneConstraints("", { noiseSuppression: true, autoGainControl: true }), {
      audio: { noiseSuppression: true, autoGainControl: true },
      video: false
    });
    assert.deepEqual(buildMicrophoneConstraints("mic-a", { noiseSuppression: false, autoGainControl: false }), {
      audio: { deviceId: { exact: "mic-a" }, noiseSuppression: false, autoGainControl: false },
      video: false
    });
  });

  it("keeps processing flags ideal and never constrains echo cancellation", () => {
    const source = readFileSync("src/lib/audioDevices.ts", "utf8");

    assert.doesNotMatch(source, /noiseSuppression:\s*\{/);
    assert.doesNotMatch(source, /autoGainControl:\s*\{/);
    // Forcing echo cancellation off would make speaker users echo.
    assert.doesNotMatch(source, /echoCancellation/);
  });

  it("prefers AudioContext output routing and maps system default to an empty sink", async () => {
    const sinks: string[] = [];
    const context = { setSinkId: async (sinkId: string) => { sinks.push(sinkId); } };
    const element = { setSinkId: async () => { throw new Error("element fallback should not run"); } };

    assert.equal(supportsAudioOutputSelection({ audioContext: context, mediaElements: [element] }), true);
    assert.equal(await applyAudioOutputDevice("speaker-a", { audioContext: context, mediaElements: [element] }), "audio-context");
    assert.equal(await applyAudioOutputDevice("", { audioContext: context }), "audio-context");
    assert.deepEqual(sinks, ["speaker-a", ""]);
  });

  it("falls back to every provided media element when AudioContext routing is unavailable", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const mediaElements = [
      { setSinkId: async (sinkId: string) => { first.push(sinkId); } },
      { setSinkId: async (sinkId: string) => { second.push(sinkId); } }
    ];

    assert.equal(supportsAudioOutputSelection({ audioContext: {}, mediaElements }), true);
    assert.equal(await applyAudioOutputDevice("speaker-b", { audioContext: {}, mediaElements }), "media-elements");
    assert.deepEqual(first, ["speaker-b"]);
    assert.deepEqual(second, ["speaker-b"]);
  });

  it("falls back to media elements when AudioContext rejects the sink change", async () => {
    const sinks: string[] = [];
    const audioContext = { setSinkId: async () => { throw new Error("not allowed"); } };
    const mediaElements = [{ setSinkId: async (sinkId: string) => { sinks.push(sinkId); } }];

    assert.equal(await applyAudioOutputDevice("speaker-c", { audioContext, mediaElements }), "media-elements");
    assert.deepEqual(sinks, ["speaker-c"]);
  });

  it("reports unsupported output routing without throwing", async () => {
    assert.equal(supportsAudioOutputSelection({ audioContext: {}, mediaElements: [{}] }), false);
    assert.equal(await applyAudioOutputDevice("speaker", { audioContext: {}, mediaElements: [{}] }), "unsupported");
  });
});
