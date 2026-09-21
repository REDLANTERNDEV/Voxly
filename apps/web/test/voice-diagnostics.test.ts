import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { safeAudioStats, VoiceDiagnostics } from "../src/lib/voiceDiagnostics.js";

describe("voice diagnostics", () => {
  it("exports only allowlisted numeric audio measurements", () => {
    const audio = safeAudioStats([
      { type: "inbound-rtp", kind: "audio", id: "private-id", ssrc: 42, packetsReceived: 20,
        audioLevel: 0.2, jitter: NaN, address: "192.0.2.1", token: "private-token", sdp: "private-sdp" },
      { type: "outbound-rtp", kind: "video", packetsSent: 15 },
      { type: "local-candidate", address: "192.0.2.2", usernameFragment: "private-ufrag" }
    ]);
    assert.deepEqual(audio, [{ type: "inbound-rtp", packetsReceived: 20, audioLevel: 0.2 }]);
  });

  it("keeps startup evidence after hours, bounds memory, and distinguishes replacement peers", () => {
    let now = 0;
    const recorder = new VoiceDiagnostics(() => now);
    const oldPeer = {}, newPeer = {};
    recorder.begin();
    recorder.record("sample", { packetsReceived: 0 }, oldPeer);
    now = 60_000;
    for (let tick = 0; tick < 1000; tick++) {
      now += 4000;
      recorder.record("sample", { packetsReceived: tick }, newPeer);
    }
    const samples = recorder.report().calls[0].samples;
    assert.equal(samples.length, 301);
    assert.equal(samples[0].atMs, 0);
    assert.notEqual(samples[0].peer, samples[1].peer);
    assert.equal(samples.at(-1)?.atMs, now);
  });

  it("retains before and after rejoin without recording outside a call and clears on logout", () => {
    const recorder = new VoiceDiagnostics(() => 1000);
    recorder.record("sample", {}, {});
    assert.equal(recorder.report().calls.length, 0);
    for (let call = 0; call < 5; call++) {
      recorder.begin();
      recorder.record("sample", { packetsReceived: call });
      recorder.end();
      recorder.record("sample", { shouldNotAppear: true });
    }
    assert.equal(recorder.report().calls.length, 3);
    assert.ok(recorder.report().calls.every(call => call.samples.length === 2));
    recorder.clear();
    assert.equal(recorder.report().calls.length, 0);
  });

  it("caps the startup buffer even with many peers and repeated events", () => {
    const recorder = new VoiceDiagnostics(() => 0);
    recorder.begin();
    for (let i = 0; i < 5000; i++) recorder.record("recovery", { reason: "quality" });
    assert.equal(recorder.report().calls[0].samples.length, 500);
  });

  it("offers an accessible local download without uploading or persisting the report", () => {
    const dock = readFileSync("src/components/shell/VoiceDock.tsx", "utf8");
    const recorder = readFileSync("src/lib/voiceDiagnostics.ts", "utf8");
    assert.match(dock, /onClick=\{downloadVoiceDiagnostics\}/);
    assert.match(dock, /aria-label=\{t\("voiceQuality.downloadDiagnostics"\)\}/);
    assert.doesNotMatch(recorder, /fetch\(|localStorage|sessionStorage|MediaRecorder/);
  });
});
