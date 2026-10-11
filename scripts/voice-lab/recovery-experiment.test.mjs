import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { recoveryControllerSource } from "./recovery-experiment.mjs";

const source = await readFile(new URL("../../apps/web/src/lib/voiceQualityController.ts", import.meta.url), "utf8");
const qualitySource = await readFile(new URL("../../apps/web/src/lib/voiceQuality.ts", import.meta.url), "utf8");
const qualityCode = ts.transpileModule(qualitySource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const quality = await import(`data:text/javascript;base64,${Buffer.from(qualityCode).toString("base64")}`);

function controller(policy) {
  const code = ts.transpileModule(recoveryControllerSource(source, policy), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {},
    decisions = [];
  new Function("require", "exports", "window", code)(
    (path) => {
      if (path === "./voiceQuality.js") return quality;
      assert.equal(path, "./voiceDiagnostics.js");
      return { safeAudioStats: () => [], voiceDiagnostics: { record() {} } };
    },
    exports,
    { voiceLab: { recoveryDecision: (_peer, decision) => decisions.push(decision) } }
  );
  let seconds = 0,
    stopped = false;
  const peer = {
    connectionState: "connected",
    getStats: async () =>
      new Map([
        [
          "mic",
          {
            id: "mic",
            type: "inbound-rtp",
            kind: "audio",
            trackIdentifier: "mic",
            packetsReceived: stopped ? 0 : seconds * 35,
            packetsLost: stopped ? 0 : seconds * 15,
            concealedSamples: stopped ? 0 : seconds * 9600,
            silentConcealedSamples: 0,
            jitterBufferEmittedCount: stopped ? 0 : seconds * 48000,
            jitterBufferDelay: seconds * 48000 * 0.04,
            removedSamplesForAcceleration: 0,
            insertedSamplesForDeceleration: 0
          }
        ]
      ])
  };
  const instance = new exports.VoiceQualityController(
    () => [{ userId: "member", peer, expectingAudio: true, microphoneTrackIds: ["mic"] }],
    () => seconds * 1000
  );
  return {
    decisions,
    sample(at, stall = false) {
      seconds = at;
      stopped = stall;
      return instance.sample();
    }
  };
}

test("legacy assets reproduce degradation recovery while production retains only genuine stalls", async () => {
  for (const policy of ["production", "legacy-degradation"]) {
    const h = controller(policy);
    await h.sample(0);
    await h.sample(4);
    const result = await h.sample(8);
    assert.equal(result.grade, "breaking");
    assert.equal(result.recoveryRequests.length, policy === "production" ? 0 : 1);
    assert.deepEqual(h.decisions.at(-1), {
      stalled: false,
      eligible: policy !== "production",
      recover: policy !== "production",
      expectingAudio: true
    });
    const stalled = controller(policy);
    await stalled.sample(0, true);
    await stalled.sample(4, true);
    assert.equal((await stalled.sample(8, true)).recoveryRequests.length, 1);
    assert.equal(stalled.decisions.at(-1).stalled, true);
  }
});

test("instrumentation observes a decision without changing its transition", () => {
  assert.ok(recoveryControllerSource(source).includes("window.voiceLab?.recoveryDecision(peer,"));
  assert.ok(
    recoveryControllerSource("recovery.set(\n peer,\n transition.state\n);").includes("recoveryDecision(peer,")
  );
  const observed = [];
  const code = recoveryControllerSource(
    "const transition = { state: 7, recover: true }; recovery.set(peer, transition.state);"
  );
  const recovery = new Map(),
    peer = {};
  new Function("window", "recovery", "peer", "stalled", "current", code)(
    { voiceLab: { recoveryDecision: (...args) => observed.push(args) } },
    recovery,
    peer,
    true,
    { expectingAudio: true }
  );
  assert.equal(recovery.get(peer), 7);
  assert.deepEqual(observed, [[peer, { stalled: true, eligible: false, recover: true, expectingAudio: true }]]);
  assert.throws(() => recoveryControllerSource("different seam"), /seam changed/);
  assert.throws(
    () => recoveryControllerSource("recovery.set(peer, transition.state);", "legacy-degradation"),
    /seam changed/
  );
});
