import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { createPendingCaptures } from "../src/lib/desktopCallState.js";

// Run the real hook action with delayed browser capture, without opening a device.
function microphoneAction(dependencies: Record<string, unknown>) {
  const source = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
  const file = ts.createSourceFile("useVoiceMedia.ts", source, ts.ScriptTarget.Latest, true);
  let expression = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "toggleMic" && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = node.initializer.arguments[0].getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(expression);
  const compiled = ts.transpile(`const action = ${expression};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(dependencies), `${compiled}; return action;`)(...Object.values(dependencies)) as () => Promise<void>;
}

function harness() {
  let resolve!: (stream: unknown) => void;
  let reject!: (cause: Error) => void;
  const capture = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  let warning = false;
  const errors: string[] = [];
  let activations = 0;
  let stops = 0;
  const roomRef = { current: "room-a" as string | null };
  const microphoneSwitchRef = { current: 0 };
  const joinAttemptRef = { current: 0 };
  const microphoneDeviceIdRef = { current: "device-a" };
  const microphoneInputRef = { current: null as unknown };
  const controlsRef = { current: { mic: { on: false }, deafen: { on: false } } };
  const moderationRef = { current: { muted: false } };
  const document = { visibilityState: "visible" };
  const localStreamsRef = { current: {} as Record<string, unknown> };
  const track = { readyState: "live", enabled: true, stop() { stops += 1; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const input = { voiceStream: stream };
  const toggle = microphoneAction({
    roomRef, microphoneSwitchRef, joinAttemptRef, microphoneDeviceIdRef, microphoneInputRef,
    controlsRef, moderationRef, localStreamsRef, document,
    deafenTransitionRef: { current: 0 }, microphoneEnabledRef: { current: false },
    micLockedByRoom: () => false,
    pendingCaptures: createPendingCaptures(),
    openMicrophoneCapture: () => capture,
    prepareMicrophoneInput: () => input,
    activateMicrophoneInput: () => { activations += 1; microphoneInputRef.current = input; localStreamsRef.current.mic = stream; },
    desktopMicrophone: { acceptedControl: (effective: boolean) => effective },
    effectiveVoiceMediaState: () => ({ mic: true }),
    setControls: () => undefined, emitMediaState: async () => undefined,
    persistVoiceResume: () => undefined, renegotiatePeers: () => undefined,
    setError: (error: string) => { if (error) errors.push(error); },
    setMicrophoneHealthWarning: (next: boolean) => { warning = next; }
  });
  return {
    toggle, resolve: () => resolve(stream), reject: () => reject(new Error("capture denied")),
    roomRef, microphoneSwitchRef, joinAttemptRef, microphoneDeviceIdRef, microphoneInputRef, controlsRef, moderationRef, document,
    get warning() { return warning; }, get activations() { return activations; }, get stops() { return stops; }, errors,
    leave() { roomRef.current = null; joinAttemptRef.current += 1; microphoneSwitchRef.current += 1; warning = false; }
  };
}

describe("microphone reacquisition lifecycle", () => {
  it("ignores capture rejection after leaving voice", async () => {
    const h = harness();
    const pending = h.toggle();
    h.leave(); h.reject(); await pending;
    assert.equal(h.warning, false);
    assert.deepEqual(h.errors, []);
  });
  it("ignores rejection belonging to a replaced capture or changed device", async () => {
    for (const replace of [
      (h: ReturnType<typeof harness>) => { h.microphoneInputRef.current = {}; },
      (h: ReturnType<typeof harness>) => { h.microphoneSwitchRef.current += 1; },
      (h: ReturnType<typeof harness>) => { h.microphoneDeviceIdRef.current = "device-b"; },
      (h: ReturnType<typeof harness>) => { h.joinAttemptRef.current += 1; }
    ]) {
      const h = harness(); const pending = h.toggle();
      replace(h); h.reject(); await pending;
      assert.equal(h.warning, false); assert.deepEqual(h.errors, []);
    }
  });
  it("stops a successful capture that arrives after leave instead of publishing it", async () => {
    const h = harness(); const pending = h.toggle();
    h.leave(); h.resolve(); await pending;
    assert.equal(h.activations, 0); assert.equal(h.stops, 1);
    assert.equal(h.warning, false);
  });
  it("does not warn after intentional deafen or owner mute while capture is pending", async () => {
    for (const lock of ["deafen", "owner"] as const) {
      const h = harness(); const pending = h.toggle();
      if (lock === "deafen") h.controlsRef.current.deafen.on = true;
      else h.moderationRef.current.muted = true;
      h.reject(); await pending;
      assert.equal(h.warning, false); assert.deepEqual(h.errors, []);
    }
  });
  it("reports current capture failure, but suppresses the health warning in the background", async () => {
    for (const visible of [true, false]) {
      const h = harness(); const pending = h.toggle();
      h.document.visibilityState = visible ? "visible" : "hidden";
      h.reject(); await pending;
      assert.equal(h.warning, visible);
      assert.deepEqual(h.errors, ["voiceError.microphonePermissionDenied"]);
    }
  });
  it("still activates a successful current capture", async () => {
    const h = harness(); const pending = h.toggle(); h.resolve(); await pending;
    assert.equal(h.activations, 1); assert.equal(h.stops, 0);
    assert.equal(h.controlsRef.current.mic.on, true); assert.deepEqual(h.errors, []);
  });
});
